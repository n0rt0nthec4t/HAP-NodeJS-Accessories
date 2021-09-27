// Code taken from https://github.com/Brandawg93/homebridge-nest-cam 
// all credit for this due there
//
// Converted back from typescript and combined into single file
// Cleaned up/recoded
//
// Mark Hulskamp
// 19/8/2020
//
// done
// -- switching camera stream on/off - going from off to on doesn't restart stream from Nest
// 
// todo
// -- When camera goes offline, we don't get notified straight away and video stream stops. Perhaps timer to go to camerra off image if no data receieve in past 15 seconds?
// -- When first called after starting, get a green screen for about 1 second. Everything is fine after that

var tls = require("tls");
var net = require("net");
var protoBuf = require("pbf");  // Proto buffer
var fs = require("fs");

// Define constants
const USERAGENT = "Nest/5.54.0.3 (iOScom.nestlabs.jasper.release) os=14.0";
const PINGINTERVAL = 15000; // 15 seconds
const TIMERINTERVAL = 1000; // 1 second
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
	constructor(accessToken, nestCamera, streamQuality) {
        this.ffmpegVideo = null;
        this.ffmpegAudio = null;
        this.ffmpegAudioReturn = null;

        this.videoStarted = false;
        this.socket = null;
        this.videoChannelID = -1;
        this.audioChannelID = -1;
        this.pendingMessages = [];
        this.pendingBuffer = null;
        this.authorised = false;
        this.quality = typeof streamQuality != "undefined" ? streamQuality : StreamProfile.VIDEO_H264_2MBIT_L40;    // Default streaming quaility

        this.timer = null;  // Internal timer handle
        this.pingtimer = null;  // Ping timer handle
        this.returnAudioTimeout = null; // Return audio timeout handle
        this.sessionID = null;  // no session ID yet.. We'll assign a random one when we connect to the nexus stream
        this.host = nestCamera.direct_nexustalk_host; // Inital host to connect to
        this.accessToken = accessToken; // Access token for authorisation
        this.camera = nestCamera; // Current camera data

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
    }
}

NexusStreamer.prototype.connectToStream = function(ffmpegVideo, ffmpegAudio, ffmpegAudioReturn) {
    // Store the ffmpeg processes for video, audio and return audio
    this.ffmpegVideo = ffmpegVideo;
    this.ffmpegAudio = ffmpegAudio;
    this.ffmpegAudioReturn = ffmpegAudioReturn;

    this.stopPlayback();
    clearInterval(this.timer);  // Clear internal timer if was running
    clearInterval(this.pingtimer);  // Clear ping timer if was running
    clearTimeout(this.returnAudioTimeout);  // Clear return audio timeout if running

    if (this.sessionID == null) this.sessionID = Math.floor(Math.random() * 100); // Random session ID
    if (this.camera.streaming_enabled == true && this.camera.online == true) {
        // Since the camera has streaming enabled and is online, start up connection

        if (this.ffmpegVideo.stdin != null) {
            this.ffmpegVideo.stdin.on("error", (error) => {
                // EPIPE errors??
            });
        }
        if (this.ffmpegAudio.stdin != null) {
            this.ffmpegAudio.stdin.on("error", (error) => {
                // EPIPE errors??
            });
        }

        // Setup audio return streaming if configured
        if (this.ffmpegAudioReturn.stdout != null) {
            this.ffmpegAudioReturn.stdout.removeAllListeners("data");   // remove any event listeners before we add one again

            this.ffmpegAudioReturn.stdout.on("data", (chunk) => {
                clearTimeout(this.returnAudioTimeout);
                this.__AudioPayload(Buffer.from(chunk));

                this.returnAudioTimeout = setTimeout(() => {
                    // no audio received, so mark end of stream
                    this.__AudioPayload(Buffer.from([]));
                    clearTimeout(this.returnAudioTimeout);
                    this.returnAudioTimeout = null;
                }, 500);
            });
        }

        this.socket = new tls.TLSSocket(new net.Socket());
    
        this.socket = tls.connect({host: this.host, port: 1443}, () => {
            // NexusStreamer Connected
            this.__Authenticate(false);
            this.pingtimer = setInterval(() => {
                this.__sendMessage(PacketType.PING, Buffer.alloc(0));   // Periodically send PING message to keep stream alive
            }, PINGINTERVAL);
        });
    
        this.socket.on("data", (data) => {
            this.__handleNexusData(data);
        });

        this.socket.on("error", (error) => {
            // Socket error
        });
    
        this.socket.on("end", () => {
            clearInterval(this.pingtimer);    // Clear ping timer
        });
    } else {
        // Camera video is off or camera is offline, so loop our appropriate messages to the video stream
        this.timer = setInterval(() => {
            // mute speaker and microphone???
            if (this.camera.online == false) {
                // Camera is offline, so feed in our custom playback packet
                if (typeof this.ffmpegVideo != "undefined") {
                    if (this.ffmpegVideo.stdin.destroyed == false && this.ffmpegVideo.stdin.writableEnded == false) {
                      // H264 NAL Units require 0001 added to beginning
                      this.ffmpegVideo.stdin.write(Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x01]), this.offline_h264_frame]));
                    }
                }
            }
            if (this.camera.streaming_enabled == false && this.camera.online == true) {
                // Camera video is turned off so feed in our custom playback packet
                if (typeof this.ffmpegVideo != "undefined") {
                    if (this.ffmpegVideo.stdin.destroyed == false && this.ffmpegVideo.stdin.writableEnded == false) {
                      // H264 NAL Units require 0001 added to beginning
                      this.ffmpegVideo.stdin.write(Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x01]), this.cameraoff_h264_frame]));
                    }
                }
            }
        }, TIMERINTERVAL);
    }
}

NexusStreamer.prototype.startPlayback = function() {
    if (this.camera.streaming_enabled == true && this.camera.online == true) {
        // Attempt to use camera's stream profile or use default
        var otherProfiles = [];
        this.camera.properties["audio.enabled"] && this.ffmpegAudio != null && otherProfiles.push(StreamProfile.AUDIO_AAC); // Include AAC if audio enabled on camera
        this.camera.capabilities.forEach((element) => {
            if (element.startsWith("streaming.cameraprofile")) {
                var profile = element.replace("streaming.cameraprofile.", "");
                var index = otherProfiles.indexOf(profile, 0);
                if (index == -1 && this.quality != StreamProfile[profile]) {
                    // Profile isn't the primary profile, and isn't in the others list, so add it
                    otherProfiles.push(StreamProfile[profile]);
                }
            }
        });

        var startBuffer = new protoBuf();
        startBuffer.writeVarintField(1, this.sessionID);   // Session ID
        startBuffer.writeVarintField(2, this.quality);    // Primary profile
        otherProfiles.forEach(otherProfile => {
            startBuffer.writeVarintField(6, otherProfile);  // Other supported profiles
        });
        this.__sendMessage(PacketType.START_PLAYBACK, startBuffer.finish());
        this.videoStarted = true;
    }
}

NexusStreamer.prototype.reconfigureStream = function(accessToken, nestCamera, ffmpegVideo, ffmpegAudio, ffmpegAudioReturn, streamQuality) {
    streamQuality && (this.quality = streamQuality);  // Update streaming quality if passed in
    if (accessToken != null && accessToken != this.accessToken) {
        // access token has changed, so re-authorise
        this.accessToken = accessToken; // Update token
        this.__Authenticate(true);    // Update authorisation only
    }
    if (typeof nestCamera.streaming_enabled == "boolean" && typeof nestCamera.online == "boolean" && (this.camera.streaming_enabled != nestCamera.streaming_enabled || this.camera.online != nestCamera.online)) {
        // Streaming enabled status and/or online status has changed
        // If we're going from camera off to camera on, we need to stop/restart steam and vise-versa
        this.camera.streaming_enabled = nestCamera.streaming_enabled;
        this.camera.online = nestCamera.online;
        //this.stopPlayback(); <- called inside connectToStream
        this.connectToStream(this.ffmpegVideo, this.ffmpegAudio, this.ffmpegAudioReturn);
        this.startPlayback();
    }
}

NexusStreamer.prototype.stopPlayback = function() {
    if (this.socket != null) {
        // Close authenicated socket stream gracefully
        var stopBuffer = new protoBuf();
        stopBuffer.writeVarintField(1, this.sessionID); // session ID
        this.__sendMessage(PacketType.STOP_PLAYBACK, stopBuffer.finish());
        this.socket.end();
        this.socket.destroy();  // get rid of this socket
    }

    this.videoStarted = false;
    this.sessionID = null;
    this.socket = null; // Kill the socket
    this.pendingMessages = []; // No more pending messages
}

NexusStreamer.prototype.__processMessages = function() {
    // Send any pending messages that might have accumulated while socket pending etc
    if (this.pendingMessages && this.pendingMessages.length > 0) {
        this.pendingMessages.forEach((message, index) => {
            this.__sendMessage(message.type, message.buffer);
            this.pendingMessages.splice(index, 1);  // Delete from pending messages as we've process it
        });
    }
}

NexusStreamer.prototype.__sendMessage = function(type, buffer) {
    if (this.socket != null) {
        if ((this.socket.connecting == true || this.socket.encrypted == false ) || (type !== PacketType.HELLO && this.authorised == false)) {
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
        if (this.socket.destroyed == false && this.socket.writableEnded == false) {
            // write our composed message to the socket
            this.socket.write(requestBuffer);
        }
    }
}

NexusStreamer.prototype.__Authenticate = function(reauthorise) {
    // Authenticate over created socket connection
    var tokenBuffer = new protoBuf();
    var helloBuffer = new protoBuf();
    tokenBuffer.writeStringField(1, this.accessToken);   // Tag 1, session token, Nest auth accounts
    //tokenBuffer.writeStringField(4, this.accessToken);   // Tag 4, olive token, Google auth accounts
    if (typeof reauthorise == "boolean" && reauthorise == true) {
        // Request to re-authorise only
        this.__sendMessage(PacketType.AUTHORIZE_REQUEST, tokenBuffer.finish());
    } else {
        // This isnt a re-authorise request, so perform "Hello" packet
        helloBuffer.writeVarintField(1, ProtocolVersion.VERSION_3,);
        helloBuffer.writeStringField(2, this.camera.camera_uuid);
        helloBuffer.writeBooleanField(3, false);
        helloBuffer.writeStringField(6, this.camera.serial_number);
        helloBuffer.writeStringField(7, USERAGENT);
        //helloBuffer.writeVarintField(9, ClientType.WEB);
        helloBuffer.writeVarintField(9, ClientType.IOS);    // iOS client type as using the Nest apps useragent string???
        helloBuffer.writeBytesField(12, tokenBuffer.finish());
        this.__sendMessage(PacketType.HELLO, helloBuffer.finish());
    }
}

NexusStreamer.prototype.__AudioPayload = function(payload) {
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

    if (packet.new_host) {
        this.host = packet.new_host;  // update internally stored host and connect it
        this.connectToStream(this.ffmpegVideo, this.ffmpegAudio, this.ffmpegAudioReturn)
        this.startPlayback();
    }
}

NexusStreamer.prototype.__handlePlaybackBegin = function(payload) {
    // Decode playback begin packet
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
        // Ensure Ppacket session ID matches our session
        packet.channels && packet.channels.forEach(stream => {
            // Find which channels match our video and audio streams
            if (stream.codec_type == CodecType.H264) this.videoChannelID = stream.channel_id;
            if (stream.codec_type == CodecType.AAC) this.audioChannelID = stream.channel_id;
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

    if (typeof this.ffmpegVideo != "undefined" && packet.channel_id === this.videoChannelID) {
        if (this.ffmpegVideo.stdin.destroyed == false && this.ffmpegVideo.stdin.writableEnded == false) {
            // H264 NAL Units require 0001 added to beginning
            this.ffmpegVideo.stdin.write(Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x01]), Buffer.from(packet.payload)]));
        }
    }
    if (typeof this.ffmpegAudio != "undefined" && packet.channel_id === this.audioChannelID) {
        if (this.ffmpegAudio.stdin.destroyed == false && this.ffmpegAudio.stdin.writableEnded == false) {
            this.ffmpegAudio.stdin.write(Buffer.from(packet.payload));
        }
    }
}

NexusStreamer.prototype.__handlePlaybackEnd = function(payload) {
    // Decode playpack ended packet
    var packet = payload.readFields(function(tag, obj, protoBuf) {
        if (tag === 1) obj.session_id = protoBuf.readVarint();
        else if (tag === 2) obj.reason = protoBuf.readVarint();
    }, {session_id: 0, reason: 0});

    // Nexusstreamer Playback ended with code '%s'", packet.reason);
    if (packet.reason === Reason.ERROR_TIME_NOT_AVAILABLE && this.videoStarted == false) {
        setTimeout(() => {
            this.startPlayback();
        }, 1000);
    }
}

NexusStreamer.prototype.__handleNexusError = function(payload) {
    // Decode error packet
    var packet = payload.readFields(function(tag, obj, protoBuf) {
        if (tag === 1) obj.code = protoBuf.readVarint();
        else if (tag === 2) obj.message = protoBuf.readString();
    }, {code: 1, message: ""});
   
    if (packet.code === ErrorCode.ERROR_AUTHORIZATION_FAILED) {
        //NexusStreamer Updating authentication
        this.__Authenticate(true);    // Update authorisation only
    } else {
        // NexusStreamer Error, packet.message contains the message
        this.stopPlayback();
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