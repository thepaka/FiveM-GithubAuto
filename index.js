const express = require('express');
const Rcon = require('rcon');
const gitpull = require('git-pull');
const bodyParser = require('body-parser');
const crypto       = require('crypto')
    , bufferEq     = require('buffer-equal-constant-time');
const yaml = require('js-yaml')
    , fs = require('fs');
const watch = require('node-watch')
const app = express();

process.env['LANG'] = 'POSIX';

var config = require('./config.json');

var f;
if (config.server_cfg_path.startsWith('/')) {
    f = config.server_cfg_path;
} else if (config.server_cfg_path != "" ) {
    f = config.git_pull_path + "/" + config.server_cfg_path;
}
console.log("using server config file : "+f);
var srv_config = yaml.load(fs.readFileSync(f));

var srv_resdir;
if (config.server_resources_path.startsWith('/')) {
    srv_resdir = config.server_resources_path;
} else if (config.server_resources_path != "" ) {
    srv_resdir = config.git_pull_path + "/" + config.server_resources_path;
}
console.log("using server resources dir : " + srv_resdir);

if (typeof config.rcon_password === "boolean" && config.rcon_password) {
    config.rcon_password = srv_config.RconPassword;
}

var conn = new Rcon(config.rcon_host, config.rcon_port, config.rcon_password, { tcp: false, challenge: false } );

conn.on('auth', function() {
    console.log("Authed!");

}).on('response', function(str) {
    console.log("Got response: " + str);

}).on('end', function() {
    console.log("Socket closed!");
    process.exit();

});

conn.connect();


var rawBodySaver = function (req, res, buf, encoding) {
    if (buf && buf.length) {
        req.rawBody = buf.toString(encoding || 'utf8');
    }
}

app.use(bodyParser.json({ verify: rawBodySaver }));
app.use(bodyParser.urlencoded({ verify: rawBodySaver, extended: true }));
app.use(bodyParser.raw({ verify: rawBodySaver, type: function () { return true } }));

function signBlob (key, blob) {
    return 'sha1=' + crypto.createHmac('sha1', key).update(blob).digest('hex');
}

function srv_refresh() {
    conn.send('refresh');
    for (var ressource of srv_config.AutoStartResources) {
        conn.send("restart " + ressource);
    }
}

app.get('/refresh', function (req, res) {
    res.send('Hello World!');
    srv_refresh();
})

app.post('/webhook', function (req, res) {
    console.log('post /webhook');

    var sig   = req.headers['x-hub-signature']

    if (!sig) {
        console.log('No X-Hub-Signature found on request');
        res.status(403).send('No X-Hub-Signature found on request');
        return;
    }

    var computedSig = new Buffer(signBlob(config.github_secret, req.rawBody))

    if (!bufferEq(new Buffer(sig), computedSig)) {
        console.log('X-Hub-Signature does not match blob signature (' + sig + ' != ' + computedSig + ')')
        res.status(403).send('X-Hub-Signature does not match blob signature')
        return;
    }

    res.send('ok');

    //console.log(JSON.stringify(req.body,null,4));

    gitpull(config.git_pull_path, function (err, consoleOutput) {
        if (err) {
            console.error("Error!", err, consoleOutput);
        } else {
            console.log("Success!", consoleOutput);
            if (consoleOutput == "Already up-to-date.") {
                console.log("No more things to do");
                return;
            }

            //srv_refresh();

        }
    });
})

app.listen(config.listen_port, function () {
    console.log('App listening on port ' + config.listen_port)
})

var watcher = watch(srv_resdir, {
	recursive: true,
	filter: function (name) {
		var fname = name.substr(name.lastIndexOf("/")+1);
		return !/(^\.|~$)/.test(fname);
	}
}, function(evt, name) {
	console.log('%s changed (%s).', name, evt);
});

watcher.on('change', function(evt, name) {
	if (evt != "update") {
		return;
	}
	find_resource(name);
});

var found_resources = [];
var timer_resource = null;
function find_resource(path) {
	if (path == srv_resdir) {
		//console.log("no resource found");
		return;
	}
	fs.lstat(path, function(err, stats) {
		if (err !== null) {
			console.log(JSON.stringify(err, null, 4));
			return;
		}
		var dpath = path.substr(0, path.lastIndexOf("/"));

		if (stats.isDirectory()) {
			//console.log(path + " is a directory in " + dpath);
			if (fs.existsSync(path + "/__resource.lua")) {
				var rname = path.substr(path.lastIndexOf("/")+1);
				//console.log("Ressource is " + rname);
				found_resources.push(rname);
                if (timer_resource === null) {
                    timer_resource = setTimeout(restart_resources, 3000);
                }
			} else {
				find_resource(dpath)
			}
		} else if (stats.isFile()) {
			//console.log(path + " is a file in " + dpath);
			find_resource(dpath)
		} else {
			//console.log(path + " is not a file or directory")
			return
		}
	});
}

function restart_resources() {
	if (found_resources.length == 0) {
        timer_resource = null;
		return
	}
	var resources = found_resources.splice(0, found_resources.length);
	resources = resources.filter(function(elem, pos) {
		return resources.indexOf(elem) == pos;
	});

	console.log("Resources to restart : "  + JSON.stringify(resources , null, 4));
    for (var ressource of resources) {
        conn.send("restart " + ressource);
    }
    if ((found_resources.length != 0) && (timer_resource === null)) {
        timer_resource = setTimeout(restart_resources, 3000);
    } else {
        timer_resource = null;
    }
}

// vim: ts=4 sw=4 et
