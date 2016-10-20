const discord_api = require("discord.js");
const ytdl = require('ytdl-core');
const fs = require('fs');
const https = require('https');
const url = require('url');
const util = require('util');

var tokens = JSON.parse(fs.readFileSync("botinfo.json"));
var queue = [];
var playing = false;
var dispatch;

const bot = new discord_api.Client();

function timestamp() {
  var ctime = new Date();
  var hrs = ctime.getUTCHours();
  if (hrs < 10) hrs = "0" + hrs;
  var mns = ctime.getUTCMinutes();
  if (mns < 10) mns = "0" + mns;
  var sec = ctime.getUTCSeconds();
  if (sec < 10) sec = "0" + sec;
  return "[" + hrs + ":" + mns + ":" + sec + "]";
}

function log(text) {
  console.log(timestamp() + " " + text);
}

function makeQueryString(obj) {
  var qlst = [];
  for (var prop in obj) {
    qlst.push(prop + "=" + obj[prop]);
  }
  return "?" + qlst.join("&");
}

function getQueryStringObject(queryurl) {
  var u = url.parse(queryurl);
  if (!u.query) return {};
  var obj = {};
  var queries = u.query.split("&")
  for (var i = 0; i < queries.length; i++) {
    var kv = queries[i].split("=");
    obj[kv[0]] = kv[1];
  }
  return obj;
}

function recurGetPlaylistContents(pId, callback, vIds=[], nextPageToken=null) {
  var queryStringBase = {
    part: "snippet",
    maxresults: 50,
    playlistId: pId,
    key: tokens.youtube_api_token
  };
  if (nextPageToken) queryStringBase.pageToken = nextPageToken;
  var apiQuery = url.format({
    protocol: 'https:',
    slashes: true,
    host: 'www.googleapis.com',
    pathname: '/youtube/v3/playlistItems',
    search: makeQueryString(queryStringBase)
  });
  https.get(apiQuery, result => {
    if (result.statusCode !== 200) callback("connection reset", result.statusCode);
    else {
      var data = "";
      result.on('data', dat => {data = data + dat;});
      result.on('end', () => {
        var pagedat = JSON.parse(data);
        if (pagedat.hasOwnProperty("error")) callback("api error", pagedat.error);
        else {
          var ids = [];
          for (var i = 0; i < pagedat.items.length; i++) {
            ids.push(pagedat.items[i].snippet.resourceId.videoId);
          }
          var newVIds = vIds.concat(ids);
          if (pagedat.hasOwnProperty("nextPageToken")) {
            recurGetPlaylistContents(pId, callback, newVIds, pagedat.nextPageToken);
          } else {
            callback(null, newVIds);
          }
        }
      });
    }
  });
}

function getPlaylistContents(playlistUrl, callback) {
  var qobj = getQueryStringObject(playlistUrl);
  if (!qobj.hasOwnProperty("list")) callback("invalid url", []);
  else {
    recurGetPlaylistContents(qobj.list, (errtext, content) => {
      if (errtext) {
        log("Error fetching playlist data; " + errtext);
      } else {
        var vidUrls = [];
        for (var i = 0; i < content.length; i++) {
          vidUrls.push("https://www.youtube.com/watch?v=" + content[i]);
        }
        callback(vidUrls);
      }
    });
  }
}

function getLinkType(linkurl) {
  var u = url.parse(linkurl);
  if (u.hostname === "www.youtube.com") {
    if (u.pathname === "/watch")
      return "video";
    else if (u.pathname === "/playlist")
      return "playlist";
  }
  return "invalid";
}

function tandemGetVideoTitles(vidlinks, callback) {
  var vidnames = [];
  var counter = 0;
  for (var i = 0; i < vidlinks.length; i++)
    vidnames.push("");
  for (var i = 0; i < vidlinks.length; i++) {
    var index = i;
    ytdl(vidlinks[index], (err, info) => {
      vidnames[index] = info.title;
      counter++;
      if (counter === vidlinks.length) {
        callback(vidnames);
      }
    });
  }
}

function recurGetVideoTitles(vidlinks, callback, names=[], index=0) {
  if (index === vidlinks.length) {
    callback(names);
  } else {
    ytdl.getInfo(vidlinks[index], (err, info) => {
      recurGetVideoTitles(vidlinks, callback, names.concat([info.title]), index + 1);
    });
  }
}

function printPlaylistNames(channel) {
  recurGetVideoTitles(queue, names => { // change back to tandem method at some point
    var s = "```Current video: " + names[0] + "\nComing up:\n";
    for (var i = 1; i < names.length; i++)
      s = s + "   " + (i + 1) + ". " + names[i] + "\n";
    channel.sendMessage(s + "```");
  });
}

function recurExhaustPlaylist(vchannel, tchannel, connection) {
  if (queue.length === 0) {
    playing = false;
    vchannel.leave();
  } else {
    playing = true;
    ytdl(queue[0], (err, info) => {
      tchannel.sendMessage("Now playing: `" + info.title + "`");
      log("Started playing new song: '" + info.title + "'");
    });
    dispatch = connection.playStream(ytdl(queue[0], {audioonly: true}));
    dispatch.setVolumeLogarithmic(0.3);
    dispatch.on('end', () => {
      if (playing) {
        queue.shift();
        recurExhaustPlaylist(vchannel, tchannel, connection);
      } else {
        log("Stopped playing.");
        vchannel.leave();
      }
    });
  }
}

bot.on("message", msg => {
  var text = msg.content;
  var args = text.split(" ").filter( l => l.length > 0 );
  if (args.length === 0) {
    return;
  }

  if (args[0] === "!list") {
    if (args.length == 1) {
      if (queue.length == 0) {
        msg.channel.sendMessage("No videos in playlist; type `!add <video url>` to add a video.");
      } else if (queue.length == 1) {
        ytdl.getInfo(queue[0], (err, info) => {
          msg.channel.sendMessage("Current video: `" + info.title + "`");
        });
      } else {
        tandemPrintPlaylistNames(msg.channel);
      }
    } else if (args[1] === "clear") {
      queue = [];
      msg.channel.sendMessage("Cleared queue.");
      log("Cleared queue.");
    }
  } else if (args[0] === "!add") {
    if (args.length == 1) {
        msg.channel.sendMessage("Provide a YouTube video or playlist url; `!add <video url>`");
    } else {
      var linktype = getLinkType(args[1]);
      if (linktype === "invalid") {
        msg.channel.sendMessage("`" + args[1] + "` is not a valid YouTube video or playlist url.");
      } else if (linktype === "video") {
        ytdl.getInfo(args[1], (err, info) => {
          if (info) {
            queue.push(args[1]);
            msg.channel.sendMessage("Added `" + info.title + "` to queue");
            log("Added new song to queue: '" + info.title + "'");
          } else {
            log("Error fetching video information; " + err);
          }
        });
      } else if (linktype === "playlist") {
        getPlaylistContents(args[1], vids => {
          queue = queue.concat(vids);
          msg.channel.sendMessage("Added videos from playlist");
        });
      }
    }
  } else if (args[0] === "!play") {
    if (queue.length === 0) {
      msg.channel.sendMessage("No videos in queue; type `!add <video url>` to add a video.");
    } else if (!msg.member.voiceChannel) {
      msg.channel.sendMessage("Join a voice channel before using `!play`");
    } else {
      msg.member.voiceChannel.join().then( c => recurExhaustPlaylist(msg.member.voiceChannel, msg.channel, c));
    }
  } else if (args[0] === "!stop") {
    if (!playing) {
      msg.channel.sendMessage("Not currently playing in a channel.");
    } else {
      playing = false;
      dispatch.end();
    }
  } else if (args[0] === "!skip") {
    if (queue.length === 0) {
      msg.channel.sendMessage("No videos in queue.");
    } else {
      ytdl(queue[0], (err, inf) => {
        msg.channel.sendMessage("Skipped video `" + inf.title + "`");
        log("Skipped current song, '" + info.title + "'");
      });
      if (playing) {
        dispatch.end();
      } else {
        queue.shift();
      }
    }
  }
});

log("Connecting to discord");
bot.login(tokens.discord_api_token);