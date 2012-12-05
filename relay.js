//  Forever.fm relay server
//  Simple, lightweight, untested.

var config = require('./config.json');
var stats = require('./stats.json');

var http = require('http');
var fs = require('fs');
var winston = require('winston');
var daemon = require("daemonize2").setup({
    main: "relay.js",
    name: "relay",
    pidfile: "relay.pid"
});

var options = {
    hostname: process.env.URL || "forever.fm",
    path: "/all.mp3",
    port: 80,
    headers: {
      "Connection": "keep-alive",
      'User-Agent': 'foreverfm-relay',
      'X-Relay-Addr': process.env.RELAY_URL || config.relay_url,
      'X-Relay-Port': config.relay_port
    }
};
var listeners = [];
var started = +new Date;
if (stats.month < 0) stats.month = (new Date()).getMonth()

var crossdomain = "";
fs.readFile('./crossdomain.xml', function(error, content) {
    if (!error) crossdomain = content;
});

var logger = new (winston.Logger)({
    transports: [
        new winston.transports.Console(
            {
                colorize: true,
                timestamp: true,
                handleExceptions: true
            }),
        new winston.transports.File(
            {
                level: 'info',
                colorize: false,
                timestamp: true,
                json: false,
                filename: 'relay.log',
                handleExceptions: true
            })
    ]
});

var check = function(callback) {
    logger.info("Attempting to connect to generator...");

    check_opts = {'method': 'HEAD'};
    for (var a in options) check_opts[a] = options[a];
    req = http.request(check_opts, function (res) {
        if ( res.statusCode != 200 && res.statusCode != 405 ) {
            logger.error("OH NOES: Got a " + res.statusCode);
        } else {
            logger.info("Got response back from generator!")
            if (typeof callback != "undefined") callback();
        }
    })
    req.end();
}

var listen = function(callback) {
    logger.info("Attempting to listen to generator...");
    req = http.request(options, function (res) {
        if ( res.statusCode != 200 ) {
            logger.error("OH NOES: Got a " + res.statusCode);
            setTimeout(function(){listen(callback)}, config.timeout);
        } else {
            logger.info("Listening to generator!")
            res.on('data', function (buf) {
	    	stats.bytes_in_month += buf.length
	   	for (l in listeners) {
		    listeners[l].write(buf);
		    stats.bytes_out_month += buf.length;
	        }
            });
            res.on('end', function () {
                logger.error("Stream ended! Restarting listener...");
                setTimeout(function(){listen(function(){})}, config.timeout);
            });
            if (typeof callback != "undefined") callback();
        }
    })
    req.end();
}

var ipof = function(req) {
    var ipAddress;
    var forwardedIpsStr = req.headers['x-forwarded-for']; 
    if (forwardedIpsStr) {
        var forwardedIps = forwardedIpsStr.split(',');
        ipAddress = forwardedIps[0];
    }
    if (!ipAddress) {
        ipAddress = req.connection.remoteAddress;
    }
    return ipAddress;
};

var available = function(response) {
    if ( listeners.length + 1 > config.listener_limit ) {
        logger.error("Listener limit exceeded: returning 301 to relay01.");
        response.writeHead(301, {'Location': "http://relay01.forever.fm/all.mp3"});
        response.end();
        return false;
    } 
    return true;
}

var save = function() {
    fs.writeFile("./stats.json", JSON.stringify(stats), function(err) {
        if (err) logger.error("Could not save statistics due to: " + err);
        else logger.info("Saved statistics.");
    });
}

var run = function() {
    logger.info("Starting server.")

    setInterval( save, config.save_interval );

    http.createServer(function(request, response) {
        request.ip = ipof(request);
        response.ip = request.ip;
        try {
            switch (request.url) {
                case "/all.mp3":
                    switch (request.method) {
                        case "GET":
                            if (available(response)) { 
                                response.writeHead(200, {'Content-Type': 'audio/mpeg'});
                                response.on('close', function () {
                                    logger.info("Removed listener: " + request.ip);
                                    listeners.splice(listeners.indexOf(response), 1);
                                });
                                listeners.push(response);
                                if (stats.peaks.listeners < listeners.length)
                                    stats.peaks.listeners = listeners.length;
                                logger.info("Added listener: " + request.ip);
                            }
                            break;
                        case "HEAD":
                            if (available(response)) {
                                response.writeHead(200, {'Content-Type': 'audio/mpeg'});
                                response.end();
                            }
                            break;
                    }
                    break;
                case "/":
		    if (stats.peaks.bytes_out_month < stats.bytes_out_month)
		        stats.peaks.bytes_out_month = stats.bytes_out_month;
                    response.write(JSON.stringify({
                        listeners: listeners.length,
                        bytes_in_month: stats.bytes_in_month,
                        bytes_out_month: stats.bytes_out_month,
                        started_at: started,
                        config: config,
                        peaks: stats.peaks
                    }));
                    response.end();
                    break;
                case "/crossdomain.xml":
                    response.writeHead(200, {'Content-Type': 'text/xml'});
                    response.write(crossdomain);
                    response.end();
                    break;
                default:
                    response.writeHead(200);
                    response.end();
                    break;
            }
        } catch (err) {
            logger.error(err);
        }
    }).listen(process.env.PORT || config.port);
}

switch (process.argv[2]) {
    case "start":
        check(function() {
            daemon.start();
        });
        break;
    case "stop":
        daemon.stop();
        break;
    default:
        check(function() {
          listen();
          run();
        });
}

