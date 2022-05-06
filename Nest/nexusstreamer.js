// Code taken from https://github.com/Brandawg93/homebridge-nest-cam 
// all credit for this due there
//
// Converted back from typescript and combined into single file
// Cleaned up/recoded
//
// Mark Hulskamp
// 6/5/2022
//
// done
// -- switching camera stream on/off - going from off to on doesn't restart stream from Nest
// -- updated to use websocket's - seem more reliable connection for streaming
// -- buffering of stream ie: const streaming from nexus
// -- routing of data to multiple connected ffmpeg processing streams. Allows single connection to nexus for the source stream
// -- restart connection when dropped if buffering
// -- support both Nest and Google accounts
// 
// todo
// -- When camera goes offline, we don't get notified straight away and video stream stops. Perhaps timer to go to camera off image if no data receieve in past 15 seconds?
// -- When first called after starting, get a green screen for about 1 second. Everything is fine after that <- not seen in ages
// -- get snapshot image for current stream if active

"use strict";

var protoBuf = require("pbf");  // Proto buffer
var fs = require("fs");
var WebSocket = require("ws");
var {spawn} = require("child_process");

// Define constants
const USERAGENT = "iPhone iOS 15.4 Dropcam/5.67.0.6 com.nestlabs.jasper.release Darwin";
const PINGINTERVAL = 15000;         // 15 seconds between each ping to nexus server while stream active
const TIMERINTERVAL = 1000;         // 1 second
const SOCKETCLOSETIMEOUT = 1000;    // Timeout after socket closed to check if is dropped connection or we closed it

const CodecType = {
    SPEEX : 0,
    PCM_S16_LE : 1,
    H264 : 2,
    AAC : 3,
    OPUS : 4,
    META : 5,
    DIRECTORS_CUT : 6,
}

const StreamProfile = {
    AUDIO_AAC : 3,
    AUDIO_SPEEX : 4,
    AUDIO_OPUS : 5,
    AUDIO_OPUS_LIVE : 13,
    VIDEO_H264_50KBIT_L12 : 6,
    VIDEO_H264_530KBIT_L31 : 7,
    VIDEO_H264_100KBIT_L30 : 8,
    VIDEO_H264_2MBIT_L40 : 9,
    VIDEO_H264_50KBIT_L12_THUMBNAIL : 10,
    META : 11,
    DIRECTORS_CUT : 12,
    VIDEO_H264_L31 : 14,
    VIDEO_H264_L40 : 15,
    AVPROFILE_MOBILE_1 : 1,
    AVPROFILE_HD_MAIN_1 : 2,
}

const ErrorCode = {
    ERROR_CAMERA_NOT_CONNECTED : 1,
    ERROR_ILLEGAL_PACKET : 2,
    ERROR_AUTHORIZATION_FAILED : 3,
    ERROR_NO_TRANSCODER_AVAILABLE : 4,
    ERROR_TRANSCODE_PROXY_ERROR : 5,
    ERROR_INTERNAL : 6,
}

const Reason = {
    ERROR_TIME_NOT_AVAILABLE : 1,
    ERROR_PROFILE_NOT_AVAILABLE : 2,
    ERROR_TRANSCODE_NOT_AVAILABLE : 3,
    ERROR_UKNOWN1 : 4,
    PLAY_END_SESSION_COMPLETE : 128,
}

const PacketType = {
    PING : 1,
    HELLO : 100,
    PING_CAMERA : 101,
    AUDIO_PAYLOAD : 102,
    START_PLAYBACK : 103,
    STOP_PLAYBACK : 104,
    CLOCK_SYNC_ECHO : 105,
    LATENCY_MEASURE : 106,
    TALKBACK_LATENCY : 107,
    METADATA_REQUEST : 108,
    OK : 200,
    ERROR : 201,
    PLAYBACK_BEGIN : 202,
    PLAYBACK_END : 203,
    PLAYBACK_PACKET : 204,
    LONG_PLAYBACK_PACKET : 205,
    CLOCK_SYNC : 206,
    REDIRECT : 207,
    TALKBACK_BEGIN : 208,
    TALKBACK_END : 209,
    METADATA : 210,
    METADATA_ERROR : 211,
    AUTHORIZE_REQUEST : 212,
}

const ProtocolVersion = {
    VERSION_1 : 1,
    VERSION_2 : 2,
    VERSION_3 : 3
}

const ClientType = {
    ANDROID : 1,
    IOS : 2,
    WEB : 3
}


class NexusStreamer {
	constructor(nestToken, tokenType, cameraData, debug) {
        this.ffmpeg = [];   // array of ffmpeg streams for the socket connection

        this.socket = null;
        this.videoChannelID = -1;
        this.audioChannelID = -1;
        this.pendingMessages = [];
        this.pendingBuffer = null;
        this.authorised = false;
        this.streamQuality = StreamProfile.VIDEO_H264_2MBIT_L40;    // Default streaming quaility

        this.timer = null;  // Internal timer handle
        this.pingtimer = null;  // Ping timer handle
        this.sessionID = null;  // no session ID yet.. We'll assign a random one when we connect to the nexus stream

        this.host = cameraData.websocket_nexustalk_host;  // Inital host to connect to

        // Get access token and set token type
        this.nestToken = nestToken;
        this.tokenType = tokenType;

        this.camera = cameraData; // Current camera data

        this.debug = typeof debug == "boolean" ? debug : false; // debug status

        // buffer for camera offline image in .h264 frame
        this.offline_h264_frame = null;
        if (fs.existsSync(__dirname + "/Nest_offline.h264")) {
            this.offline_h264_frame = fs.readFileSync(__dirname + "/Nest_offline.h264");
        }

        // buffer for camera stream off image in .h264 frame
        this.cameraoff_h264_frame = null; 
        if (fs.existsSync(__dirname + "/Nest_cameraoff.h264")) {
            this.cameraoff_h264_frame = fs.readFileSync(__dirname + "/Nest_cameraoff.h264");
        }

        this.debug && console.debug("[NEXUS] Streamer created for '%s'", this.host);
    }
}

NexusStreamer.prototype.startBuffering = function(milliseconds) {
    if (typeof this.ffmpeg.find(({ type }) => type == "buffer") == "undefined") {
        // We only support one buffering stream per Nexus object ie: per camera
        if (typeof milliseconds == "undefined") {
            milliseconds = 15000;    // Wasnt specified how much streaming time we hold in our buffer, so default to 15 seconds
        }

        this.ffmpeg.push({type: "buffer", video: null, audio: null, size: milliseconds, buffer: []});   // push onto our ffmpeg streams array
        this.__close();
        this.__connect();
        this.__startNexusData();   // start processing data
        this.debug && console.debug("[NEXUS] Started buffering from '%s' with size of '%s'", this.host, milliseconds);
    }
}

NexusStreamer.prototype.startLiveStream = function(sessionID, videoStream, audioStream, audioReturnStream) {
    // Setup error catching for video/audio streams
    videoStream != null && videoStream.on("error", (error) => {
        // EPIPE errors??
    });
    audioStream != null && audioStream.on("error", (error) => {
        // EPIPE errors??
    });

    if ((this.ffmpeg.findIndex(({ type }) => type == "buffer") == -1) && this.socket == null) {
        // We not doing any buffering and there isnt an active socket connection, so startup connection to nexus
        this.__close();
        this.__connect();
        this.__startNexusData();
    }
    
    // Should have an active connection here now, so can add video/audio stream handles for our ffmpeg router to handle
    var index = (this.ffmpeg.push({type: "live", id: sessionID, video: videoStream, audio: audioStream, return: audioReturnStream, timeout: null}) - 1);

    // Setup audio return streaming if configured and allowed
    if (audioReturnStream != null) {
        audioReturnStream.on("error", (error) => {
            // EPIPE errors??
        });
        audioReturnStream.on("data", (data) => {
            clearTimeout(this.ffmpeg[index].timeout);   // Clear return audio timeout
            this.__AudioPayload(Buffer.from(data));

            this.ffmpeg[index].timeout = setTimeout(() => {
                // no audio received in 500ms, so mark end of stream
                this.__AudioPayload(Buffer.from([]));
            }, 500);
        });
    }

    // finally, we've started live stream
    this.debug && console.debug("[NEXUS] Started live stream from '%s'", this.host);
}

NexusStreamer.prototype.startRecordStream = function(sessionID, ffmpegRecord, videoStream, audioStream) {
    // Setup error catching for video/audio streams
    videoStream != null && videoStream.on("error", (error) => {
        // EPIPE errors??
    });
    audioStream != null && audioStream.on("error", (error) => {
        // EPIPE errors??
    });

    var bufferIndex = this.ffmpeg.findIndex(({ type }) => type == "buffer");
    if (bufferIndex == -1 || this.socket == null) {
        // We not doing any buffering and/or there isnt an active socket connection, so startup connection to nexus
        this.__close();
        this.__connect();
        this.__startNexusData();
    }
    if (bufferIndex != -1) {
        // Seems we have a buffer active, so the live stream will come from there
        this.debug && console.debug("[NEXUS] Sending data from buffer before starting stream recording. Buffer segments total '%s'", this.ffmpeg[bufferIndex].buffer.length)

        // Send any buffered data to the recording stream before switching to "head" buffer position. Buffer is Last-in/First-Out
        if (bufferIndex !=  -1) {
            for (var bufferData = this.ffmpeg[bufferIndex].buffer.shift(); bufferData; bufferData = this.ffmpeg[bufferIndex].buffer.shift()) {
                if (bufferData.type == "video" && videoStream != null) {
                    videoStream.write(bufferData.data);
                }
                if (bufferData.type == "audio" && audioStream != null) {
                    audioStream.write(bufferData.data);
                }
            }
        }
    }

    // Should have an active connection here now, so can add video/audio streams for our ffmpeg router to handle
    var index = (this.ffmpeg.push({type: "record", id: sessionID, record: ffmpegRecord, video: videoStream, audio: audioStream}) - 1);

    // Finally we've started the recording stream
    this.debug && console.debug("[NEXUS] Started recording stream from '%s'", this.host);
}

NexusStreamer.prototype.stopRecordStream = function(sessionID) {
    // Request to stop a recording stream
    var index = this.ffmpeg.findIndex(({ type, id }) => type == "record" && id == sessionID);
    if (index != -1) {
        this.debug && console.log("[NEUXS] Stopped recording stream from '%s'", this.host);
        this.ffmpeg.splice(index, 1);   // remove this object
    }

    // If we have no more streams active, we'll close the socket to nexus
    if (this.ffmpeg.length == 0) {
        // Don't have any other streams going, so can close the active socket connection
        this.__close();

        this.sessionID = null;
        this.socket = null; // Kill the socket
        this.pendingMessages = []; // No more pending messages
        this.host = this.camera.websocket_nexustalk_host;   // default back to initial host
    }
}

NexusStreamer.prototype.stopLiveStream = function(sessionID) {
    // Request to stop an active live stream
    var index = this.ffmpeg.findIndex(({ type, id }) => type == "live" && id == sessionID);
    if (index != -1) {
        this.debug && console.log("[NEUXS] Stopped live stream from '%s'", this.host);
        this.ffmpeg[index].timeout && clearTimeout(this.ffmpeg[index].timeout); // Clear any active return audio timer
        this.ffmpeg.splice(index, 1);   // remove this object
    }

    // If we have no more streams active, we'll close the socket to nexus
    if (this.ffmpeg.length == 0) {
        // Don't have any other streams going, so can close the active socket connection
        this.__close();

        this.sessionID = null;
        this.socket = null; // Kill the socket
        this.pendingMessages = []; // No more pending messages
        this.host = this.camera.websocket_nexustalk_host;   // default back to initial host
    }
}

NexusStreamer.prototype.stopBuffering = function() {
    var index = this.ffmpeg.findIndex(({ type }) => type == "buffer");
    if (index != -1) {
        // we have a buffer session, so close it down
        this.debug && console.debug("[NEXUS] Stopped buffering from '%s'", this.host);
        this.ffmpeg.buffer = null;  // Clean up first
        this.ffmpeg.splice(index, 1);   // remove this object
    }
    // If we have no more streams active, we'll close the socket to nexus
    if (this.ffmpeg.length == 0) {
        // Don't have any other streams going, so can close the active socket connection
        this.__close();

        this.sessionID = null;
        this.socket = null; // Kill the socket
        this.pendingMessages = []; // No more pending messages
        this.host = this.camera.websocket_nexustalk_host;   // default back to initial host
    }
}

NexusStreamer.prototype.update = function(nestToken, tokenType, cameraData) {
    if (nestToken != this.nestToken || tokenType != this.tokenType) {
        // access token has changed and/or token type has changed, so re-authorise
        this.tokenType = tokenType; // Update token type
        this.nestToken = nestToken; // Update token
        this.__Authenticate(true);    // Update authorisation only
    }
    if (cameraData && cameraData.websocket_nexustalk_host != this.camera.websocket_nexustalk_host) {
        // host has changed, so treat as a re-direct if any video active
        this.debug && console.log("[NEXUS] redirect requested from '%s' to '%s'", this.camera.websocket_nexustalk_host, cameraData.websocket_nexustalk_host);
        this.camera.websocket_nexustalk_host = cameraData.websocket_nexustalk_host;

        if (this.socket != null && this.ffmpeg.length >= 1) {
            this.__stopNexusData();
            this.__close();     // Close existing socket
            this.__connect();   // Connect to new host
            this.__startNexusData();    // Restart processing Nexus data
        }
    }
    if (typeof cameraData.streaming_enabled == "boolean" && typeof cameraData.online == "boolean" && (this.camera.streaming_enabled != cameraData.streaming_enabled || this.camera.online != cameraData.online)) {
        // Streaming enabled status and/or online status has changed
        // If we're going from camera off to camera on, we need to stop/restart steam and vise-versa
        this.camera.streaming_enabled = cameraData.streaming_enabled;
        this.camera.online = cameraData.online;

        if (this.socket == null && this.ffmpeg.length >= 1) {
            this.__close();     // Close existing socket
            this.__connect();   // Connect to Nexus for stream
            this.__startNexusData();    // Restart processing Nexus data
        }
    }
}

NexusStreamer.prototype.__connect = function () {
    clearInterval(this.pingtimer);  // Clear ping timer if was running

    if (this.sessionID == null) this.sessionID = Math.floor(Math.random() * 100); // Random session ID
    if (this.camera.streaming_enabled == true && this.camera.online == true) {
        this.socket = new WebSocket("wss://" + this.host + "/nexustalk");
        this.socket.on("open", () => {
            // Connected to Nexus server, so now need to authenticate ourselves
            this.debug && console.debug("[NEXUS] Establised connection to '%s'", this.host);
            this.__Authenticate(false);

            this.pingtimer = setInterval(() => {
                  // Periodically send PING message to keep stream alive
                  // Doesnt seem to work???
                this.__sendMessage(PacketType.PING, Buffer.alloc(0));
            }, PINGINTERVAL);
        });

        this.socket.on("message", (data) => {
            this.__handleNexusData(data);
        });

        this.socket.on("error", (error) => {
            // Socket error
            this.debug && console.debug("[NEXUS] Socket error", error);
        });

        this.socket.on("close", () => {
            clearInterval(this.pingtimer);    // Clear ping timer
            this.debug && console.debug("[NEXUS] Socket closed to '%s'", this.host);

            if (this.socket != null && this.socket.readyState == WebSocket.CLOSED && this.ffmpeg.length >= 1) {
                // Since we still have ffmpeg streams registered, would indicate we didnt close the socket
                // so re-connect and start processing data again
                // update host to connected to??
                this.host = this.camera.websocket_nexustalk_host;
                this.__close();
                this.__connect();
                this.__startNexusData();
            }
        });
    }
    
    // Setup timer for when camera video is off or camera is offline, so loop our appropriate messages to the video stream
    clearInterval(this.timer);
    this.timer = setInterval(() => {
        if (this.camera.online == false) {
            // Camera is offline, so feed in our custom h264 frame for playback
            this.__ffmpegRouter("video", Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x01]), this.offline_h264_frame]))
        }
        if (this.camera.streaming_enabled == false && this.camera.online == true) {
            // Camera video is turned off so feed in our custom h264 frame for playback
            this.__ffmpegRouter("video", Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x01]), this.cameraoff_h264_frame]))
        }
    }, TIMERINTERVAL);
}

NexusStreamer.prototype.__close = function() {
    // Close an authenicated socket stream gracefully
    if (this.socket != null) {
        var stopBuffer = new protoBuf();
        stopBuffer.writeVarintField(1, this.sessionID); // session ID
        this.__sendMessage(PacketType.STOP_PLAYBACK, stopBuffer.finish());
        if (this.socket.readyState != WebSocket.CLOSED) {
            this.socket.close();
        }
    }
    this.socket = null;
}

NexusStreamer.prototype.__startNexusData = function() {
    if (this.camera.streaming_enabled == true && this.camera.online == true) {
        // Attempt to use camera's stream profile or use default
        var otherProfiles = [];
        this.camera.audio_enabled == true && otherProfiles.push(StreamProfile.AUDIO_AAC); // Include AAC if audio enabled on camera
        this.camera.capabilities.forEach((element) => {
            if (element.startsWith("streaming.cameraprofile")) {
                var profile = element.replace("streaming.cameraprofile.", "");
                var index = otherProfiles.indexOf(profile, 0);
                if (index == -1 && this.streamQuality != StreamProfile[profile]) {
                    // Profile isn't the primary profile, and isn't in the others list, so add it
                    otherProfiles.push(StreamProfile[profile]);
                }
            }
        });

        var startBuffer = new protoBuf();
        startBuffer.writeVarintField(1, this.sessionID);   // Session ID
        startBuffer.writeVarintField(2, this.streamQuality);    // Default profile. ie: high quality 
        otherProfiles.forEach(otherProfile => {
            startBuffer.writeVarintField(6, otherProfile);  // Other supported profiles
        });
        this.__sendMessage(PacketType.START_PLAYBACK, startBuffer.finish());
    }
}

NexusStreamer.prototype.__stopNexusData = function() {
    var stopBuffer = new protoBuf();
    stopBuffer.writeVarintField(1, this.sessionID);   // Session ID
    this.__sendMessage(PacketType.STOP_PLAYBACK, stopBuffer.finish());
}

NexusStreamer.prototype.__ffmpegRouter = function(type, data) {
    // Send out our nexus data to any streams we're managing, including performing any buffering as required
    this.ffmpeg.forEach(ffmpeg => {
        if (ffmpeg.type == "buffer") {
            // We have a buffering stream active, so add data to its buffer first
            // Ensure we only have the specified milliseconds of data buffered also
            if (ffmpeg.buffer.length > 0 && ffmpeg.buffer[0].time < (Date.now() - ffmpeg.size)) {
                ffmpeg.buffer.shift();
            }
            ffmpeg.buffer.push({time: Date.now(), type: type, data: data});
        }
        if (type == "video" && ffmpeg.video != null) {
            ffmpeg.video.write(data);
        }
        if (type == "audio" && ffmpeg.audio != null) { 
            ffmpeg.audio.write(data);
        }
    });
}

NexusStreamer.prototype.__processMessages = function() {
    // Send any pending messages that might have accumulated while socket pending etc
    if (this.pendingMessages && this.pendingMessages.length > 0) {
        for (let message = this.pendingMessages.shift(); message; message = this.pendingMessages.shift()) {
            this.__sendMessage(message.type, message.buffer);
        }
    }
}

NexusStreamer.prototype.__sendMessage = function(type, buffer) {
    if (this.socket != null) {
        if ((this.socket.readyState === WebSocket.CONNECTING) || (type !== PacketType.HELLO && this.authorised == false)) {
            this.pendingMessages.push({type, buffer});
            return;
        }

        var requestBuffer;
        if (type === 0xcd) {
            // Long packet
            requestBuffer = Buffer.alloc(5);
            requestBuffer[0] = type;
            requestBuffer.writeUInt32BE(buffer.length, 1);
        } else {
            requestBuffer = Buffer.alloc(3);
            requestBuffer[0] = type;
            requestBuffer.writeUInt16BE(buffer.length, 1);
        }
        requestBuffer = Buffer.concat([requestBuffer, Buffer.from(buffer)]);
        if (this.socket.readyState === WebSocket.OPEN) {
            // write our composed message to the socket
            this.socket.send(requestBuffer, () => {
                // Message sent. Dont do anything?
            });
        }
    }
}

NexusStreamer.prototype.__Authenticate = function(reauthorise) {
    // Authenticate over created socket connection
    var tokenBuffer = new protoBuf();
    var helloBuffer = new protoBuf();
    if (this.tokenType == "nest") {
        tokenBuffer.writeStringField(1, this.nestToken);   // Tag 1, session token, Nest auth accounts
        helloBuffer.writeStringField(4, this.nestToken);   // session token, Nest auth accounts
    }
    if (this.tokenType == "google") {
        tokenBuffer.writeStringField(4, this.nestToken);   // Tag 4, olive token, Google auth accounts
        helloBuffer.writeBytesField(12, tokenBuffer.finish());    // olive token, Google auth accounts
    }
    if (typeof reauthorise == "boolean" && reauthorise == true) {
        // Request to re-authorise only
        this.debug && console.debug("[NEXUS] Re-authentication to '%s'", this.host);
        this.__sendMessage(PacketType.AUTHORIZE_REQUEST, tokenBuffer.finish());
    } else {
        // This isnt a re-authorise request, so perform "Hello" packet
        this.debug && console.debug("[NEXUS] Performing authentication on '%s'", this.host);
        helloBuffer.writeVarintField(1, ProtocolVersion.VERSION_3);
        helloBuffer.writeStringField(2, this.camera.camera_uuid);
        helloBuffer.writeBooleanField(3, false);
        helloBuffer.writeStringField(6, this.camera.serial_number);
        helloBuffer.writeStringField(7, USERAGENT);
        helloBuffer.writeVarintField(9, ClientType.WEB);
        this.__sendMessage(PacketType.HELLO, helloBuffer.finish());
    }
}

NexusStreamer.prototype.__AudioPayload = function(payload) {
    // Encode audio packet for sending to camera
    var audioBuffer = new protoBuf();
    audioBuffer.writeBytesField(1, payload);    // audio data
    audioBuffer.writeVarintField(2, this.sessionID);    // session ID
    audioBuffer.writeVarintField(3, CodecType.SPEEX);   // codec
    audioBuffer.writeVarintField(4, 16000); // sample rate, 16k
    this.__sendMessage(PacketType.AUDIO_PAYLOAD, audioBuffer.finish());
}

NexusStreamer.prototype.__handleRedirect = function(payload) {
    // Decode redirect packet to determine new host
    var packet = payload.readFields(function(tag, obj, protoBuf) {
        if (tag === 1) obj.new_host = protoBuf.readString();  // new host
        else if (tag === 2) obj.is_transcode = protoBuf.readBoolean();
    }, {new_host: "", is_transcode: false});

    if (packet.new_host && packet.new_host != "") {
        this.debug && console.log("[NEXUS] Redirect requested from '%s' to '%s'", this.host, packet.new_host);
        this.host = packet.new_host;  // update internally stored host and connect it

        if (this.socket != null) {
            this.__close();     // Close existing socket
            this.__connect();   // Connect to new host
            this.__startNexusData();    // Restart processing Nexus data
        }
    }
}

NexusStreamer.prototype.__handlePlaybackBegin = function(payload) {
    // Decode playback begin packet
    this.debug && console.debug("[NEXUS] Playback started from '%s'", this.host);
    var packet = payload.readFields(function(tag, obj, protoBuf) {
        if (tag === 1) obj.session_id = protoBuf.readVarint();
        else if (tag === 2) obj.channels.push(protoBuf.readFields(function(tag, obj, protoBuf) {
            if (tag === 1) obj.channel_id = protoBuf.readVarint();
            else if (tag === 2) obj.codec_type = protoBuf.readVarint();
            else if (tag === 3) obj.sample_rate = protoBuf.readVarint();
            else if (tag === 4) obj.private_data.push(protoBuf.readBytes());
            else if (tag === 5) obj.start_time = protoBuf.readDouble();
            else if (tag === 6) obj.udp_ssrc = protoBuf.readVarint();
            else if (tag === 7) obj.rtp_start_time = protoBuf.readVarint();
            else if (tag === 8) obj.profile = protoBuf.readVarint();
        }, {channel_id: 0, codec_type: 0, sample_rate: 0, private_data: [], start_time: 0, udp_ssrc: 0, rtp_start_time: 0, profile: 3}, protoBuf.readVarint() + protoBuf.pos));
        else if (tag === 3) obj.srtp_master_key = protoBuf.readBytes();
        else if (tag === 4) obj.srtp_master_salt = protoBuf.readBytes();
        else if (tag === 5) obj.fec_k_val = protoBuf.readVarint();
        else if (tag === 6) obj.fec_n_val = protoBuf.readVarint();
    }, {session_id: 0, channels: [], srtp_master_key: null, srtp_master_salt: null, fec_k_val: 0, fec_n_val: 0});

    if (packet.session_id == this.sessionID) {
        // Ensure Packet session ID matches our session
        packet.channels && packet.channels.forEach(stream => {
            // Find which channels match our video and audio streams
            if (stream.codec_type == CodecType.H264) {
                this.videoChannelID = stream.channel_id;
            }
            if (stream.codec_type == CodecType.AAC) {
                this.audioChannelID = stream.channel_id;
            }
        });
    }
}

NexusStreamer.prototype.__handlePlaybackPacket = function(payload) {
    // Decode playback packet
    var packet = payload.readFields(function(tag, obj, protoBuf) {
        if (tag === 1) obj.session_id = protoBuf.readVarint();
        else if (tag === 2) obj.channel_id = protoBuf.readVarint();
        else if (tag === 3) obj.timestamp_delta = protoBuf.readSVarint();
        else if (tag === 4) obj.payload = protoBuf.readBytes();
        else if (tag === 5) obj.latency_rtp_sequence = protoBuf.readVarint();
        else if (tag === 6) obj.latency_rtp_ssrc = protoBuf.readVarint();
        else if (tag === 7) obj.directors_cut_regions.push(protoBuf.readFields(function(tag, obj, protoBuf) {
            if (tag === 1) obj.id = protoBuf.readVarint();
            else if (tag === 2) obj.left = protoBuf.readVarint();
            else if (tag === 3) obj.right = protoBuf.readVarint();
            else if (tag === 4) obj.top = protoBuf.readVarint();
            else if (tag === 5) obj.bottom = protoBuf.readVarint();
        }, { id: 0, left: 0, right: 0, top: 0, bottom: 0 }, protoBuf.readVarint() + protoBuf.pos));
    }, {session_id: 0, channel_id: 0, timestamp_delta: 0, payload: null, latency_rtp_sequence: 0, latency_rtp_ssrc: 0, directors_cut_regions: []});

    // Handle video packet
    if (packet.channel_id === this.videoChannelID) {
        // H264 NAL Units require 0001 added to beginning
        var videoData = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x01]), Buffer.from(packet.payload)]);
        this.__ffmpegRouter("video", videoData);
    }

    // Handle audio packet
    if (packet.channel_id === this.audioChannelID) {
        var audioData = Buffer.from(packet.payload);
        this.__ffmpegRouter("audio", audioData);
    }
}

NexusStreamer.prototype.__handlePlaybackEnd = function(payload) {
    // Decode playpack ended packet
    var packet = payload.readFields(function(tag, obj, protoBuf) {
        if (tag === 1) obj.session_id = protoBuf.readVarint();
        else if (tag === 2) obj.reason = protoBuf.readVarint();
    }, {session_id: 0, reason: 0});

    if (packet.reason != Reason.ERROR_TIME_NOT_AVAILABLE && packet.reason != 0) {
        setTimeout(() => {
            // Not a normal playback ended error, so restart playback after a short delay
            this.debug && console.debug("[NEXUS] Playback ended on '%s' but will restart", this.host, packet.session_id, packet.reason);
            this.__startNexusData();
        }, 1000);
    } else {
        this.debug && console.debug("[NEXUS] Playback ended on '%s'", this.host, packet.session_id, packet.reason);
    }
}

NexusStreamer.prototype.__handleNexusError = function(payload) {
    // Decode error packet
    var packet = payload.readFields(function(tag, obj, protoBuf) {
        if (tag === 1) obj.code = protoBuf.readVarint();
        else if (tag === 2) obj.message = protoBuf.readString();
    }, {code: 1, message: ""});
   
    if (packet.code === ErrorCode.ERROR_AUTHORIZATION_FAILED) {
        // NexusStreamer Updating authentication
        this.__Authenticate(true);    // Update authorisation only
    } else {
        // NexusStreamer Error, packet.message contains the message
        this.debug && console.debug("[NEXUS] Error", packet.message);
    }
}

NexusStreamer.prototype.__handleNexusData = function(data) {
    // Process the rawdata from our socket connection and convert into nexus packets to take action against
    this.pendingBuffer = (this.pendingBuffer == null ? data : Buffer.concat([this.pendingBuffer, data]));
    var type = this.pendingBuffer.readUInt8();
    var headerLength = 3;
    var length = this.pendingBuffer.readUInt16BE(1);

    if (type == PacketType.LONG_PLAYBACK_PACKET) {
        // Adjust header size and data length based upon packet type
        headerLength = 5;
        length = this.pendingBuffer.readUInt32BE(1);
    }

    var payloadEndPosition = length + headerLength;
    if (this.pendingBuffer.length >= payloadEndPosition) {
        var payload = new protoBuf(this.pendingBuffer.slice(headerLength, payloadEndPosition));
        switch (type) {
            case PacketType.OK : {
                this.authorised = true;
                this.__processMessages();
                break;
            }
    
            case PacketType.ERROR : {
                this.__handleNexusError(payload);
                break;
            }
    
            case PacketType.PLAYBACK_BEGIN : {
                this.__handlePlaybackBegin(payload);
                break;
            }
    
            case PacketType.PLAYBACK_END : {
                this.__handlePlaybackEnd(payload);
                break;
            }
    
            case PacketType.LONG_PLAYBACK_PACKET :
            case PacketType.PLAYBACK_PACKET : {
                this.__handlePlaybackPacket(payload);
                break;
            }

            case PacketType.REDIRECT : {
                this.__handleRedirect(payload);
                break;
            }

            default: {
                // We didn't process this type of packet
                break
            }
        }
        var remainingData = this.pendingBuffer.slice(payloadEndPosition);
        this.pendingBuffer = null;
        if (remainingData.length > 0) {
            this.__handleNexusData(remainingData);  // Maybe not do this recursive???
        }
    }
}

module.exports = NexusStreamer;