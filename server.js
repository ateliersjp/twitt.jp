const fs = require("fs");
const process = require("process");
const util = require("util");
const express = require("express");
const morgan = require("morgan");
const rfs = require("rotating-file-stream");
const mkdirp = require("mkdirp");
const fetch = require("node-fetch");
const jsdom = require("jsdom");
const m = require("motionless");

const nitterlist_url = "https://github.com/zedeus/nitter/wiki/Instances";
const re_hostname = /^([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}$/;
const instances = [];
const check_interval = 1000 * 60 * 5;

function index() {
  const template = m.dom(m.load("index.html"));
  const ui = template.$("main").innerHTML;
  const readme = m.load("README.md");
  const content = readme
    .replace("<!-- ui goes here -->", "<div id='ui'></div>")
    .replace("<!-- instances -->", instances.length);
  const dynamic = m.md(content);
  template.$("main").innerHTML = dynamic;
  template.$("#ui").innerHTML = ui;
  return template.render();
}

function load_initial_data() {
  fs.readFile("instances.json", (err, data) => {
    if (err) {
      console.log("Couldn't read instances from file.");
    } else if (data) {
      try {
        const stored_instances = JSON.parse(data.toString()) || [];
        stored_instances.forEach(url=>instances.push(url));
        console.log("Loaded " + stored_instances.length + " instances.");
      } catch (error) {
        console.log("Couldn't parse instances from file.");
      }
    }
  });
}

function serve() {
  const app = express();

  const port = process.env.PORT || 8000;

  const logs = __dirname + "/logs";
  mkdirp(logs);

  const accesslog = rfs.createStream("access.log", {"interval": "1d", "path": logs, "compress": "gzip"});

  // set up error logging
  const errorlog = rfs.createStream("error.log", {"interval": "7d", "path": logs, "compress": "gzip"});
  const stdout = process.stdout;
  function logfn(...args) {
    const date = (new Date()).toISOString().replace(/\..*/, "").split("T");
    const out = date.join(" ") + " " + util.format.apply(null, args) + "\n";
    stdout.write(out);
    errorlog.write(out);
  }
  console.log = logfn;
  console.error = logfn;

  app.use(morgan("combined", {"stream": accesslog}));

  app.all("*", (req, res) => {
    // pick a random nitter instance and redirect
    const instance = instances[Math.floor(Math.random() * instances.length)];
    if (instance) {
      res.redirect(instance + req.originalUrl);
    } else {
      res.status(421).header("Content-type", "text/plain").send("Sorry, couldn't find a Nitter instance.");
    }
  });

  app.listen(port, () => console.log("Twiiit app listening on port " + port + "."));
}

function fetch_server_list() {
  return new Promise(function(res, err) {
    // testing from a file
    /*fs.promises.readFile("instances.html")
      .then(function(f) {
        return {
          ok: true,
          text: function() { return f.toString(); }
        };
      })*/
    // download the list of nitter instances
    fetch(nitterlist_url)
      .then(function(response) {
        if (response.ok) {
          console.log("Nitter Wiki list fetch ok.");
          return response.text();
        } else {
          console.log("Nitter Wiki list fetch failed.");
          res([]);
        }
      }).then(function(page) {
      const dom = new jsdom.JSDOM(page);
      const tables = dom.window.document.querySelectorAll("a#user-public,table");
      const trs = Array.from(dom.window.document.querySelectorAll("table tbody tr"));
      const trs_filtered = trs.filter(tr=>re_hostname.test(tr.querySelector("td").textContent));
      const urls = [];
      if (trs_filtered.length) {
        trs_filtered.forEach(function(row) {
          //console.log("row", row);
          const fields = Array.from(row.querySelectorAll("td"));
          //console.log("fields", fields.map(f=>f.innerHTML));
          if (fields[0] && fields[1] && fields[1].innerHTML.indexOf("✅") != -1) {
            //console.log(fields[0].innerHTML, fields[1].innerHTML);
            const a = fields[0].querySelector("a");
            if (a) {
              const href = a.getAttribute("href");
              urls.push(href.replace(/\/+$/, ""));
            }
          }
        });
      }
      console.log("Nitter Wiki list: " + urls.length + " urls.");
      urls.push("https://nitter.net");
      res(urls);
    })
    .catch(function(error) {
      console.error(error);
      res([]);
    });
  });
}

// https://dmitripavlutin.com/timeout-fetch-request/
async function fetch_with_timeout(resource, options = {}) {
  const { timeout = 15000 } = options;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  const response = await fetch(resource, {
    ...options,
    signal: controller.signal
  });
  clearTimeout(id);
  return response;
}

function check_for_error(page, error) {
  //console.log("Checking", error, page.indexOf(error) == -1);
  return page.indexOf(error) == -1;
}

function test_server_list(urls) {
  //console.log("here", urls);
  // test each one for overload
  return Promise.all(urls.map(function(url) {
    return new Promise(function(res, err) {
      // if server times out after 15 seconds an abort will be thrown and server ignored
      fetch_with_timeout(url + "/jack").then(function(response) {
        if (response.ok) {
          return response.text();
        } else {
          console.log(url + "/jack failed to load.");
          res(null);
        }
      }).catch(function(error) {
        console.error(error);
        res(null);
      }).then(function(page) {
        //console.log(url, page.indexOf("error-panel"));
        //console.log(url);
        const error_check = page && check_for_error(page, "error-panel");
        const timeline_check = page && (check_for_error(page, "timeline-none") || check_for_error(page, "No items found"));
        const timeline_item_check = page && !check_for_error(page, "timeline-item");
        if (page && error_check && timeline_check && timeline_item_check) {
          res(url);
        } else {
          console.log(url + " did not pass error checks.");
          res(null);
        }
      });
    });
  }));
}

function filter_failing_urls(urls) {
  return urls.filter(t=>t);
}

function maintain_instance_list() {
  console.log(new Date());
  console.log("maintain_instance_list started.");
  fetch_server_list().then(test_server_list).then(filter_failing_urls).then(function(urls) {
    // if we got any valid urls, replace our current set
    if (urls.length) {
      instances.length = 0;
      urls.forEach(url=>instances.push(url));
      fs.writeFile("instances.json", JSON.stringify(urls), (err) => { if (err) console.error(err); });
      console.log(instances.length, "instances available");
    } else {
      console.log("No valid URLs, keeping current URL set (" + instances.length + ").");
    }
    setTimeout(maintain_instance_list, check_interval);
  });
}

if (process.argv.includes("--test-site-checker")) {
  console.log("Testing instance checker.");
  fetch_server_list().then(test_server_list).then(filter_failing_urls).then(console.log);
} else {
  load_initial_data();
  serve();
  maintain_instance_list();
  // restart once per day ugh
  // this is to work around persistent issues with the tasks stopping running
  setTimeout(function() { console.log("Daily restart."); process.exit(0); }, 1000 * 60 * 60 * 24);
}
