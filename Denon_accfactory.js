// HAP-Nodejs Denon AVR AMP
// 
// https://github.com/subutux/denonavr/blob/master/CommandEndpoints.txt
// https://github.com/scarface-4711/denonavr
// https://www.heimkinoraum.de/upload/files/product/IP_Protocol_AVR-Xx100.pdf
//
// todo
// -- create multiple zones (ie: main, zone2, zone3 etc)
// -- get firmware version
// -- add tuner presets as inputs
// -- subscribe to changes??
// -- dymanically add new devices
//
// done
// -- switched to axios library
// -- discover all AMPs using UDP on the local network and create accessories for each one
// -- if enabling/disabling inputs in HomeKit, refected status on AMP
// -- if inputs renamed in HomeKit, reflected on AMP
// -- update input name during status updates in HomeKit
// -- fixed getting volume mute state
// -- add tuner FM/AM switching as inputs
// -- handle input status when current source is airplay
// -- cache power status when switching off via HomeKit so update routine shows off
// -- updated to use npm version of hap-nodejs directory structure (11/4/2020) 
//
// Version 15/4/2020
// Mark Hulskamp

module.exports = accessories = [];

var Accessory = require("../").Accessory; 
var Service = require("../").Service;
var Characteristic = require("../").Characteristic;
var uuid = require("../").uuid;
var parseString = require("xml2js").parseString;
var axios = require("axios");
var dgram = require('dgram');   // for UDP

// Defines for the accessory
const AccessoryName =  "Amplifier";             // default name of accessory
const AccessoryPincode = "031-45-154";          // pin code for paring  

const DISCOVERTIMEOUT = 5000;
const AMPTURNONDELAY = 10000;                    // Time takes AMP to turn on and accept commands from off state
const AMPCOMMANDDELAY = 100;                    // Delay between AMP commands

// Create the AMP system object.
function DenonClass() {
    this.__IPAddress = "";                      // IP Address of AMP
    this.__AMPService = null;                   // HomeKit service for the AMP.. We'll use the TV service
    this.__SpeakerService = null;               // HomeKit service for the AMP volume
    this.__AVInputs = [];                       // array of input objects.
    this.__cachedPowerState = null;
    this.__cachedInput = null;
    this.__updatingHomeKit = false;             // Flag if were doing a HomeKit update or not
}

function InputClass() {
    this.__ID = null;
    this.__InputService = null;
    this.__Name = null;
    this.__SelectName = null;
    this.__AllowAMPUpdate = [];
}

DenonClass.prototype.addAmplifier = async function(HomeKitAccessory, thisServiceName, serviceNumber) {
    this.__AMPService = HomeKitAccessory.addService(Service.Television, thisServiceName, serviceNumber);
    this.__AMPService.getCharacteristic(Characteristic.ConfiguredName).updateValue(thisServiceName);
    this.__AMPService.getCharacteristic(Characteristic.SleepDiscoveryMode).updateValue(Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);
    HomeKitAccessory.setPrimaryService(this.__AMPService);

    // Add the AMP volume as a service
    this.__SpeakerService = HomeKitAccessory.addService(Service.TelevisionSpeaker);
    this.__SpeakerService.getCharacteristic(Characteristic.VolumeControlType).updateValue(Characteristic.VolumeControlType.ABSOLUTE);
    this.__AMPService.addLinkedService(this.__SpeakerService);

    // Setup callbacks
    this.__AMPService.getCharacteristic(Characteristic.Active).on('set', this.setPowerState.bind(this));
    this.__AMPService.getCharacteristic(Characteristic.ActiveIdentifier).on('set', this.setActiveInput.bind(this));
    this.__AMPService.getCharacteristic(Characteristic.RemoteKey).on('set', this.sendRemoteKey.bind(this));
    this.__SpeakerService.getCharacteristic(Characteristic.VolumeSelector).on('set', this.setVolume.bind(this));
    this.__AMPService.getCharacteristic(Characteristic.PowerModeSelection).on('set', this.accessAMPSettings.bind(this));

    // Build list of inputs for the AMP
    await this.__buildInputList(HomeKitAccessory);

    console.log("Setup Amplifier '%s' on '%s'", thisServiceName, HomeKitAccessory.username);
}

DenonClass.prototype.setPowerState = function(value, callback) {
    this.__updatingHomeKit = true;
    this.__cachedPowerState = null;
    
    // Turns on/off the Amplifier
    axios.get("http://" + this.__IPAddress + "/goform/formiPhoneAppDirect.xml/?ZM" + (value == Characteristic.Active.ACTIVE ? "ON" : "OFF"))
    .then(response => {
        if (response.status == 200) {
            if (this.__SpeakerService != null) {
                this.__SpeakerService.getCharacteristic(Characteristic.Active).updateValue(value);
            }
        }
    })
    .finally(() => {
        this.__cachedPowerState = value;    // Cache the power state we set for update loop.. Allows updated HomeKit status correctly as AMP takes a few seconds to return its turn power state if queried
        setTimeout(function() {
            this.__cachedPowerState = null;
        }.bind(this), AMPTURNONDELAY);

        callback(); // set power state
        this.__updatingHomeKit = false;
    })
    .catch(error => console.log("DEBUG: " + arguments.callee.name, AccessoryName, error.message));
}

DenonClass.prototype.setActiveInput = function(value, callback) {
    this.__cachedInput = null;

    // Switch selected input on the amplifier
    this.__AVInputs.forEach(AVInput => {
        // search through the input list to work out which input we need to select on the AMP
        if (value == AVInput.__ID) {
            this.__updatingHomeKit = true;
            axios.get("http://" + this.__IPAddress + "/goform/formiPhoneAppDirect.xml/?SI" + (AVInput.__Name == "TUNER" ? "TUNER" : AVInput.__SelectName))
            .then(response => {
                if (response.status == 200 && AVInput.__Name == "TUNER") {
                    axios.post("http://" + this.__IPAddress + "/goform/AppCommand.xml", '<?xml version="1.0" encoding="utf-8"?> <tx> <cmd id="1">GetAllZonePowerStatus</cmd> </tx>', {headers: {'Content-Type': 'text/xml'}})
                    .then(response => {
                        if (response.status == 200) {
                            var xmlObject = {};
                            parseString(response.data, function (err, result) {
                                xmlObject = result;
                            });
                    
                            // Since the selected input was a tuner, now switch the band on the tuner after small delay to allow AMP to settle if powered on
                            setTimeout(function(AVInput) {
                                axios.get("http://" + this.__IPAddress + "/goform/formiPhoneAppDirect.xml/?TMAN" + AVInput.__SelectName.substr(5,AVInput.__SelectName.length - 5));    // Should be "AM or "FM"
                            }.bind(this), (xmlObject.rx.cmd[0].zone1[0].toUpperCase() == "ON" ? AMPCOMMANDDELAY : AMPTURNONDELAY), AVInput);
                        }
                    });
                }
            })
            .finally(() => {
                this.__cachedInput = value;
                setTimeout(function() {
                    this.__cachedInput = null;
                }.bind(this), AMPTURNONDELAY);

                callback(); // set input
                this.__updatingHomeKit = false;
            })
            .catch(error => console.log("DEBUG: " + arguments.callee.name, AccessoryName, error.message));
        }
    });
}

DenonClass.prototype.sendRemoteKey = function(value, callback) {
    var tempRemoteKey = "";
    switch (value) {
        case Characteristic.RemoteKey.REWIND :
        {
            tempRemoteKey = '';
            break;
        }

        case Characteristic.RemoteKey.FAST_FORWARD :
        {
            tempRemoteKey = '';
            break;
        }

        case Characteristic.RemoteKey.NEXT_TRACK :
        {
            tempRemoteKey = 'NS9D';
            break;
        }

        case Characteristic.RemoteKey.PREVIOUS_TRACK :
        {
            tempRemoteKey = 'NS9E';
            break;
        }

        case Characteristic.RemoteKey.ARROW_UP :
        {
            tempRemoteKey = 'MNCUP';
            break;
        }

        case Characteristic.RemoteKey.ARROW_DOWN :
        {
            tempRemoteKey = 'MNCDN';
            break;
        }

        case Characteristic.RemoteKey.ARROW_LEFT :
        {
            tempRemoteKey = 'MNCLT';
            break;
        }

        case Characteristic.RemoteKey.ARROW_RIGHT :
        {
            tempRemoteKey = 'MNCRT';
            break;
        }
        case Characteristic.RemoteKey.SELECT : 
        {
            tempRemoteKey = 'MNENT';
            break;
        }

        case Characteristic.RemoteKey.BACK :
        {
            tempRemoteKey = 'MNRTN';
            break;
        }

        case Characteristic.RemoteKey.EXIT :
        {
            tempRemoteKey = 'MNRTN';
            break;
        }

        case Characteristic.RemoteKey.PLAY_PAUSE :
        {
            tempRemoteKey = 'NS94';
            break;
        }

        case Characteristic.RemoteKey.INFORMATION :
        {
            tempRemoteKey = 'MNINF';
            break;
        }
    }
    if (tempRemoteKey != "") {
        axios.get("http://" + this.__IPAddress + "/goform/formiPhoneAppDirect.xml/?" + tempRemoteKey);
    }
    callback();
}

DenonClass.prototype.setVolume = function(value, callback) {
    this.__updatingHomeKit = true;
    axios.get("http://" + this.__IPAddress + "/goform/formiPhoneAppDirect.xml/?MV" + (value == Characteristic.VolumeSelector.INCREMENT ? "UP" : "DOWN"));
    callback();
    this.__updatingHomeKit = false;
}

DenonClass.prototype.accessAMPSettings = function(value, callback) {
    axios.get("http://" + this.__IPAddress + "/goform/formiPhoneAppDirect.xml/?MNMEN%20"+ (value == Characteristic.PowerModeSelection.SHOW ? "ON" : "OFF"));
    callback();
}

DenonClass.prototype.hideShowAMPInput = function(context, value, callback) {
    this.__updatingHomeKit = true;

    // Show or hide avilable AMP inputs selection in HomeKit      
    context.__InputService.getCharacteristic(Characteristic.CurrentVisibilityState).updateValue(value);
    context.__InputService.getCharacteristic(Characteristic.TargetVisibilityState).updateValue(value);  

    if (context.__AllowAMPUpdate[1] == true) {
        // Reflect input's shown/hidden status on the AMP. Can only set when AMP is on... TODO work around. perhaps some caching the set when power on??
        axios.post("http://" + this.__IPAddress + "/goform/AppCommand0300.xml", '<?xml version="1.0" encoding="utf-8"?> <tx> <cmd id="3"> <name>SetHideSources</name> <list> <param name="' + context.__Name + '">' + (value == Characteristic.TargetVisibilityState.SHOWN ? 1 : 0) + '</param> </list> </cmd> </tx>"', {headers: {'Content-Type': 'text/xml'}});
    }
    callback();
    this.__updatingHomeKit = false;
}

DenonClass.prototype.setAMPInputName = function(context, value, callback) {
    this.__updatingHomeKit = true;

    // Update AMP inputs name in HomeKit
    context.__InputService.getCharacteristic(Characteristic.ConfiguredName).updateValue(value);

    if (context.__AllowAMPUpdate[0] == true) {
        // Reflect input's name on the AMP. Can only set when AMP is on... TODO work around. perhaps some caching the set when power on??
        axios.post("http://" + this.__IPAddress + "/goform/AppCommand0300.xml", '<?xml version="1.0" encoding="utf-8"?> <tx> <cmd id="3"> <name>SetSourceRename</name> <list> <param name="' + context.__Name + '">' + value + '</param> </list> </cmd> </tx>"', {headers: {'Content-Type': 'text/xml'}});
    }
    callback();

    this.__updatingHomeKit = false;
}

DenonClass.prototype.refreshHomeKit = function(HomeKitAccessory, refreshTimeMS) {
    // setup status check interval as defined
    this.__updateHomeKit(HomeKitAccessory, true, refreshTimeMS);
    console.log("HomeKit refresh for '%s' set for every '%s'ms", AccessoryName, refreshTimeMS);
}

DenonClass.prototype.__buildInputList = async function(HomeKitAccessory) {
    this.__updatingHomeKit = true;

    await axios.all([
        axios.post("http://" + this.__IPAddress + "/goform/AppCommand.xml", '<?xml version="1.0" encoding="utf-8"?> <tx><cmd id="1">GetRenameSource</cmd> <cmd id="1">GetDeletedSource</cmd></tx>'),
        axios.get("http://" + this.__IPAddress + "/goform/Deviceinfo.xml")
    ])
    .then(axios.spread(function (inputlist, tunerlist) {
        if (inputlist.status == 200) {
            var xmlObject = {};
            parseString(inputlist.data, function (err, result) {
                xmlObject = result;
            });

            // build list of inputs (except for a tuner, which we'll handle seperately)
            xmlObject.rx.cmd[0].functionrename[0].list.forEach(functionrename => {
                if (functionrename.name[0].trim().toUpperCase() != "TUNER") {
                    var tempInput = new InputClass();
                    tempInput.__ID = (this.__AVInputs.length + 1);
                    tempInput.__InputService = HomeKitAccessory.addService(Service.InputSource, functionrename.name[0].trim(), tempInput.__ID);
                    tempInput.__Name = functionrename.name[0].trim();
                    tempInput.__InputService.getCharacteristic(Characteristic.ConfiguredName).updateValue(functionrename.rename[0].trim());
                    tempInput.__InputService.getCharacteristic(Characteristic.Identifier).updateValue(tempInput.__ID);

                    switch(functionrename.name[0].trim().toUpperCase()) {
                        case "CD" : {
                            tempInput.__InputService.getCharacteristic(Characteristic.InputSourceType).updateValue(Characteristic.InputSourceType.HDMI);
                            tempInput.__SelectName = "CD";
                            tempInput.__AllowAMPUpdate = [true, true];  // Rename, hide
                            break;
                        }

                        case "CBL/SAT" : {
                            tempInput.__InputService.getCharacteristic(Characteristic.InputSourceType).updateValue(Characteristic.InputSourceType.HDMI);
                            tempInput.__SelectName = "SAT/CBL";
                            tempInput.__AllowAMPUpdate = [true, true];  // Rename, hide
                            break;
                        }

                        case "DVD" : {
                            tempInput.__InputService.getCharacteristic(Characteristic.InputSourceType).updateValue(Characteristic.InputSourceType.HDMI);
                            tempInput.__SelectName = "DVD";
                            tempInput.__AllowAMPUpdate = [true, true];  // Rename, hide
                            break;
                        }

                        case "BLU-RAY" : {
                            tempInput.__InputService.getCharacteristic(Characteristic.InputSourceType).updateValue(Characteristic.InputSourceType.HDMI);
                            tempInput.__SelectName = "BD";
                            tempInput.__AllowAMPUpdate = [true, true];  // Rename, hide
                            break;
                        }

                        case "GAME" : {
                            tempInput.__InputService.getCharacteristic(Characteristic.InputSourceType).updateValue(Characteristic.InputSourceType.HDMI);
                            tempInput.__SelectName = "GAME";
                            tempInput.__AllowAMPUpdate = [true, true];  // Rename, hide
                            break;
                        }

                        case "AUX1" : {
                            tempInput.__InputService.getCharacteristic(Characteristic.InputSourceType).updateValue(Characteristic.InputSourceType.HDMI);
                            tempInput.__SelectName = "AUX1";
                            tempInput.__AllowAMPUpdate = [true, true];  // Rename, hide
                            break;
                        }

                        case "AUX2" : {
                            tempInput.__InputService.getCharacteristic(Characteristic.InputSourceType).updateValue(Characteristic.InputSourceType.HDMI);
                            tempInput.__SelectName = "AUX2";
                            tempInput.__AllowAMPUpdate = [true, true];  // Rename, hide
                            break;
                        }

                        case "MEDIA PLAYER" : {
                            tempInput.__InputService.getCharacteristic(Characteristic.InputSourceType).updateValue(Characteristic.InputSourceType.HDMI);
                            tempInput.__SelectName = "MPLAY";
                            tempInput.__AllowAMPUpdate = [true, true];  // Rename, hide
                            break;
                        }

                        case "IPOD/USB" : {
                            tempInput.__InputService.getCharacteristic(Characteristic.InputSourceType).updateValue(Characteristic.InputSourceType.USB);
                            tempInput.__SelectName = "USB/IPOD";
                            tempInput.__AllowAMPUpdate = [false, true];  // Rename, hide
                            break;
                        }

                        case "TV AUDIO" : {
                            tempInput.__InputService.getCharacteristic(Characteristic.InputSourceType).updateValue(Characteristic.InputSourceType.TV);
                            tempInput.__SelectName = "TV";
                            tempInput.__AllowAMPUpdate = [true, true];  // Rename, hide
                            break;
                        }

                        case "NETWORK" : {
                            tempInput.__InputService.getCharacteristic(Characteristic.InputSourceType).updateValue(Characteristic.InputSourceType.AIRPLAY);
                            tempInput.__SelectName = "NET";
                            tempInput.__AllowAMPUpdate = [false, true];  // Rename, hide
                            break;
                        }

                        case "BLUETOOTH" : {
                            tempInput.__InputService.getCharacteristic(Characteristic.InputSourceType).updateValue(Characteristic.InputSourceType.AIRPLAY);
                            tempInput.__SelectName = "BT";
                            tempInput.__AllowAMPUpdate = [false, true];  // Rename, hide
                            break;
                        }

                        case "SPOTIFYCONNECT" : {
                            tempInput.__InputService.getCharacteristic(Characteristic.InputSourceType).updateValue(Characteristic.InputSourceType.APPLICATION);
                            tempInput.__SelectName = "SPOTIFY";
                            tempInput.__AllowAMPUpdate = [false, false];  // Rename, hide
                            break;
                        }
                        
                        default: {
                            tempInput.__InputService.getCharacteristic(Characteristic.InputSourceType).updateValue(Characteristic.InputSourceType.OTHER);
                            tempInput.__SelectName = "";
                            tempInput.__AllowAMPUpdate = [false, false];  // Rename, hide
                            console.log("DEBUG: Got a inpout type we dont handle", functionrename.name[0].trim());
                            break;
                        }
                    }

                    // Loop through to see if this input is "hidden" on the AMP. Mark as shown or hidden depending on configuration
                    tempInput.__InputService.getCharacteristic(Characteristic.IsConfigured).updateValue(Characteristic.IsConfigured.CONFIGURED);
                    tempInput.__InputService.getCharacteristic(Characteristic.CurrentVisibilityState).updateValue(Characteristic.CurrentVisibilityState.SHOWN);
                    tempInput.__InputService.getCharacteristic(Characteristic.TargetVisibilityState).updateValue(Characteristic.CurrentVisibilityState.SHOWN);

                    xmlObject.rx.cmd[1].functiondelete[0].list.forEach(functiondelete => {
                        if ((functiondelete.name[0].trim().toUpperCase() == functionrename.name[0].trim().toUpperCase()) && parseInt(functiondelete.use) == 0) {
                            tempInput.__InputService.getCharacteristic(Characteristic.CurrentVisibilityState).updateValue(Characteristic.CurrentVisibilityState.HIDDEN);
                            tempInput.__InputService.getCharacteristic(Characteristic.TargetVisibilityState).updateValue(Characteristic.CurrentVisibilityState.HIDDEN);
                        }
                    });
        
                    tempInput.__InputService.getCharacteristic(Characteristic.TargetVisibilityState).on('set', (value, callback) => {this.hideShowAMPInput(tempInput, value, callback)});
                    tempInput.__InputService.getCharacteristic(Characteristic.ConfiguredName).on('set', (value, callback) => {this.setAMPInputName(tempInput, value, callback)});
        
                    this.__AMPService.addLinkedService(tempInput.__InputService);
                    this.__AVInputs.push(tempInput);  // add to array of inputs
                }
            });
        }

        if (tunerlist.status == 200) {
            var xmlObject = {};
            parseString(tunerlist.data, function (err, result) {
                xmlObject = result;
            });

            // build list of inputs for configured tuners, create seperate tuner inputs for each band present
            xmlObject.Device_Info.DeviceZoneCapabilities[0].Operation[0].TunerOperation[0].BandList[0].Band.forEach(band => {
                var tempInput = new InputClass();
                tempInput.__ID = (this.__AVInputs.length + 1);
                tempInput.__InputService = HomeKitAccessory.addService(Service.InputSource, "Tuner", tempInput.__ID);
                tempInput.__Name = "TUNER";
                tempInput.__InputService.getCharacteristic(Characteristic.ConfiguredName).updateValue("Tuner (" + band.Name[0] + ")");
                tempInput.__InputService.getCharacteristic(Characteristic.Identifier).updateValue(tempInput.__ID);
                tempInput.__InputService.getCharacteristic(Characteristic.InputSourceType).updateValue(Characteristic.InputSourceType.TUNER);
                tempInput.__SelectName = "TUNER" + band.Name[0].toUpperCase();
                tempInput.__AllowAMPUpdate = [false, false];  // Rename, hide

                tempInput.__InputService.getCharacteristic(Characteristic.IsConfigured).updateValue(Characteristic.IsConfigured.CONFIGURED);
                tempInput.__InputService.getCharacteristic(Characteristic.CurrentVisibilityState).updateValue(Characteristic.CurrentVisibilityState.SHOWN);
                tempInput.__InputService.getCharacteristic(Characteristic.TargetVisibilityState).updateValue(Characteristic.CurrentVisibilityState.SHOWN);
                tempInput.__InputService.getCharacteristic(Characteristic.TargetVisibilityState).on('set', (value, callback) => {this.hideShowAMPInput(tempInput, value, callback)});
                tempInput.__InputService.getCharacteristic(Characteristic.ConfiguredName).on('set', (value, callback) => {this.setAMPInputName(tempInput, value, callback)});

                this.__AMPService.addLinkedService(tempInput.__InputService);
                this.__AVInputs.push(tempInput);  // add to array of inputs
            });
        }
    }.bind(this)))
    .finally(() => {
        this.__updatingHomeKit = false;
    })
    .catch(error => console.log("DEBUG: " + arguments.callee.name, AccessoryName, error.message));
}

DenonClass.prototype.__updateHomeKit = function(HomeKitAccessory, triggerTimeout, refreshTimeMS) {
    const scale = (num, in_min, in_max, out_min, out_max) => {
        if (num > in_max) num = in_max;
        if (num < in_min) num = in_min;
        return (num - in_min) * (out_max - out_min) / (in_max - in_min) + out_min;
    }

    if (this.__updatingHomeKit == false) {
        axios.post("http://" + this.__IPAddress + "/goform/AppCommand.xml", '<?xml version="1.0" encoding="utf-8"?> <tx> <cmd id="1">GetAllZonePowerStatus</cmd> <cmd id="1">GetAllZoneSource</cmd> <cmd id="1">GetAllZoneVolume</cmd> <cmd id="1">GetAllZoneMuteStatus</cmd> <cmd id="1">GetTunerStatus</cmd> <cmd id="1">GetRenameSource</cmd> <cmd id="1">GetDeletedSource</cmd> </tx>', {headers: {'Content-Type': 'text/xml'}})
        .then(response => {
            if (response.status == 200) {
                var xmlObject = {};
                parseString(response.data, function (err, result) {
                    xmlObject = result;
                });

                // Update power on/off state
                if (this.__cachedPowerState == null) {
                    this.__AMPService.getCharacteristic(Characteristic.Active).updateValue(xmlObject.rx.cmd[0].zone1[0].toUpperCase() == 'ON' ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE);
                }
                else {
                    // Cached update status so set this. 
                    this.__AMPService.getCharacteristic(Characteristic.Active).updateValue(this.__cachedPowerState);
                }

                // Update to show which input is active
                this.__AVInputs.forEach(AVInput => {
                    // search through the input list to work out which input is currently selected or use cached value
                    if (xmlObject.rx.cmd[1].zone1[0].source[0].split(" ")[0].toUpperCase() == AVInput.__SelectName.toUpperCase() || 
                        (xmlObject.rx.cmd[1].zone1[0].source[0].toUpperCase() == "TUNER" && ("TUNER" + xmlObject.rx.cmd[4].band[0].toUpperCase() == AVInput.__SelectName.toUpperCase())) ||
                        (xmlObject.rx.cmd[1].zone1[0].source[0].split(" ")[0].toUpperCase() == "AIRPLAY" && AVInput.__SelectName.toUpperCase() == "NET") ||
                        (this.__cachedInput != null && AVInput.__ID == this.__cachedInput)) {

                        this.__AMPService.getCharacteristic(Characteristic.ActiveIdentifier).updateValue(AVInput.__ID);
                    }
                });

                // Update speaker volume to reflect what AMP says, scaling from -80.5 <> 18db to 0 <> 100 for HomeKit
                this.__SpeakerService.getCharacteristic(Characteristic.Volume).updateValue(scale(parseInt(xmlObject.rx.cmd[2].zone1[0].volume[0]), -80.5, 18, 0, 100));
                this.__SpeakerService.getCharacteristic(Characteristic.Mute).updateValue((xmlObject.rx.cmd[3].zone1[0].toUpperCase() == "ON" ? true : false));

                // Updated input names from AMP
                xmlObject.rx.cmd[5].functionrename[0].list.forEach(functionrename => {
                    this.__AVInputs.forEach(AVInput => {
                        if (functionrename.name[0].trim().toUpperCase() != "TUNER" && AVInput.__Name.toUpperCase() === functionrename.name[0].trim().toUpperCase()) {
                            AVInput.__InputService.getCharacteristic(Characteristic.ConfiguredName).updateValue(functionrename.rename[0].trim());
                        }
                    });
                });

                // Update configured inputs ie: which are shown/hidden
                xmlObject.rx.cmd[6].functiondelete[0].list.forEach(functiondelete => {
                    this.__AVInputs.forEach(AVInput => {
                        if (AVInput.__Name == functiondelete.name[0].trim().toUpperCase()) {
                            AVInput.__InputService.getCharacteristic(Characteristic.CurrentVisibilityState).updateValue(parseInt(functiondelete.use) == 1 ? Characteristic.CurrentVisibilityState.SHOWN : Characteristic.CurrentVisibilityState.HIDDEN);
                            AVInput.__InputService.getCharacteristic(Characteristic.TargetVisibilityState).updateValue(parseInt(functiondelete.use) == 1 ? Characteristic.CurrentVisibilityState.SHOWN : Characteristic.CurrentVisibilityState.HIDDEN);
                        }
                    });
                });
            }

        })
        .finally(() => {
            if (triggerTimeout == true) {
                setTimeout(this.__updateHomeKit.bind(this, HomeKitAccessory, true, refreshTimeMS), refreshTimeMS); 
            }
        })
        .catch(error => console.log("DEBUG: " + arguments.callee.name, AccessoryName, error.message));
    } else {
        if (triggerTimeout == true) {
            setTimeout(this.__updateHomeKit.bind(this, HomeKitAccessory, true, refreshTimeMS), refreshTimeMS); 
        }
    }
}


// General functions
function doDiscovery(callback) {
    var foundDevices = [];
    var udpSocket = dgram.createSocket({type:"udp4", reuseAddr:true});
    udpSocket.bind(0, "0.0.0.0", function () {
        udpSocket.addMembership('224.0.0.1');
        udpSocket.setBroadcast(true);
    });

    udpSocket.on('message', function (chunk, info) {
        // Callback triggered when we've received a UDP response
        var ssdpURL = new URL(chunk.toString().split("LOCATION: ")[1].split("\r\n")[0]);
        if (ssdpURL.port == 8080 && (ssdpURL.pathname.toLowerCase() == "/description.xml" || ssdpURL.pathname.toLowerCase() == "/RenderingControl/desc.xml") && foundDevices.some(ip => ip.IPAddress === ssdpURL.hostname.split(":")[0]) == false) {
            // Have not found this device before, so add to array of discovered systems
            foundDevices.push({IPAddress: ssdpURL.hostname.split(":")[0], ssdpURL: ssdpURL.href});
         }
    });

    udpSocket.on('listening', function() {
        // UDP socket opened to listen, so send the queries

        var udpQuery1 = 
        "M-SEARCH * HTTP/1.1\r\n" +
        "HOST:239.255.255.250:1900\r\n" +
        "MAN:\"ssdp:discover\"\r\n" +
        "ST:urn:schemas-upnp-org:device:MediaServer:1\r\n" + 
        "MX:2\r\n" +
        "\r\n";
        var udpQuery2 = 
        "M-SEARCH * HTTP/1.1\r\n" +
        "HOST:239.255.255.250:1900\r\n" +
        "MAN:\"ssdp:discover\"\r\n" +
        "ST:urn:schemas-denon-com:device:ACT-Denon:1\r\n" + 
        "MX:2\r\n" +
        "\r\n";
        var udpQuery3 = 
        "M-SEARCH * HTTP/1.1\r\n" +
        "HOST:239.255.255.250:1900\r\n" +
        "MAN:\"ssdp:discover\"\r\n" +
        "ST:urn:schemas-upnp-org:device:MediaRenderer:1\r\n" + 
        "MX:2\r\n" +
        "\r\n";
        udpSocket.send(udpQuery1, 0, udpQuery1.length, 1900, "239.255.255.250");
        udpSocket.send(udpQuery2, 0, udpQuery2.length, 1900, "239.255.255.250");
        udpSocket.send(udpQuery3, 0, udpQuery3.length, 1900, "239.255.255.250");
    });

    setTimeout(function () {
        udpSocket.close();
        callback(foundDevices);
    }, DISCOVERTIMEOUT);
}


// Startup code
doDiscovery(function(devices) { 
    devices && devices.forEach(device => {
        axios.get(device.ssdpURL)
        .then(response => {
            if (response.status == 200) {
                var xmlObject = {};
                parseString(response.data, function (err, result) {
                    xmlObject = result;
                });

                var tempMACAddress = xmlObject.root.device[0].serialNumber[0].substr(0,2) + ":" + xmlObject.root.device[0].serialNumber[0].substr(2,2) + ":" + xmlObject.root.device[0].serialNumber[0].substr(4,2) + ":" + xmlObject.root.device[0].serialNumber[0].substr(6,2) + ":" + xmlObject.root.device[0].serialNumber[0].substr(8,2) + ":" + xmlObject.root.device[0].serialNumber[0].substr(10,2); // We'll use the AMPs mac address for the HomeKit one
                var tempAccessory = exports.accessory = new Accessory(xmlObject.root.device[0].friendlyName[0], uuid.generate("hap-nodejs:accessories:denon_" + xmlObject.root.device[0].serialNumber[0]));
                tempAccessory.username = tempMACAddress;
                tempAccessory.pincode = AccessoryPincode;
                tempAccessory.category = Accessory.Categories.AUDIO_RECEIVER;    // Show receiver type icon for pairing
                tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Manufacturer, xmlObject.root.device[0].manufacturer[0]);
                tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Model, xmlObject.root.device[0].modelNumber[0]);
                tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.SerialNumber, xmlObject.root.device[0].serialNumber[0]);
                tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, xmlObject.root.device[0].version);
            
                tempAccessory.__thisObject = new DenonClass(); // Store the object
                tempAccessory.__thisObject.__IPAddress = device.IPAddress; // Store IP address of the AMP for later calls
                tempAccessory.__thisObject.addAmplifier(tempAccessory, xmlObject.root.device[0].friendlyName[0], 1)
                .then(() => {
                    tempAccessory.__thisObject.refreshHomeKit(tempAccessory, 2000);  // Refresh HomeKit every 2 seconds after inital updates

                    accessories.push(tempAccessory);   // Push onto export array for HAP-NodeJS "accessory factory"
                    tempAccessory.publish({username: tempAccessory.username, pincode: tempAccessory.pincode, category: tempAccessory.category});    // Publish accessory on local network
                });
            }
        })
        .catch(error => console.log("DEBUG: " + arguments.callee.name, AccessoryName, error.message));
    });
});
