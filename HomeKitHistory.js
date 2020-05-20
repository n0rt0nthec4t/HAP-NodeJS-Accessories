// HomeKit history service
// Simple history service for HomeKit developed accessories with HAP-NodeJS
//
// todo
// -- import history for sprinkler/irrigation systems to EveHome (Aqua)
// -- get humidity recordings for EveHome thermo
// -- notify Eve when new history entries added
//
// done
// -- initial support for importing our history into EveHome
// -- developed simple history service for HomeKit HAP-NodeJS accessories
//
// Version 20/5/2020
// Mark Hulskamp

const MAX_HISTORY_SIZE = 16384; // 16k entries
const EPOCH_OFFSET = 978307200; // Seconds since 1/1/1970 to 1/1/2001
const EVEHOME_MAX_STREAM = 11;  // Maximum number of history events we can stream to EveHome at once

var Service = require("../").Service;
var Characteristic = require("../").Characteristic;
var util = require("util");
var fs = require("fs");
var storage = require("node-persist");

class HomeKitHistory {
	constructor(HomeKitAccessory, optionalParams) {

        this.fillTimer = null;
        if (typeof (optionalParams) === "object") {
            this.maxEntries = optionalParams.maxEntries || MAX_HISTORY_SIZE; // used for rolling history. if 0, means no rollover
            this.location = optionalParams.location || "";
        }
        else {
            this.maxEntries = MAX_HISTORY_SIZE; // used for rolling history. if 0, means no rollover
            this.location = "";
        }

        // Setup HomeKitHistory storage using HAP-NodeJS persist location
        // can be overridden by passing in location optional parameter
        this.storageKey = util.format("History.%s.json", HomeKitAccessory.username.replace(/:/g, "").toUpperCase());
        if (this.location != "" && typeof this.location == "string") storage.init({dir: this.location});
		this.historyData = storage.getItem(this.storageKey);
		if (typeof this.historyData != "object") {
            // Getting storage key didnt return an object, we'll assume no history present, so start new history for this accessory
            this.resetHistory();    // Start with blank history
        }

        this.restart = Math.floor(new Date() / 1000);   // time we restarted

        // perform rollover if needed when starting service
        if (this.maxEntries != 0 && this.historyData.next >= this.maxEntries) {
            this.rolloverHistory();
        }

		return this;	// Return object to our service
	}
}

HomeKitHistory.prototype.addHistory = function(service, entry) {
    // we'll use the service or characteristic UUID to determine the history entry time and data we'll add
    // reutil.format the entry object to order the fields consistantly in the output
    // Add new history types in the switch statement
    var historyEntry = {};
    if (this.restart != null && typeof entry.restart == "undefined") {
        // Object recently created, so log the time restarted our history service 
        entry.restart = this.restart;
        this.restart = null;
    }
    if (typeof entry.time == "undefined") {
        // No logging time was passed in, so set
        entry.time = Math.floor(new Date() / 1000);
    }
    if (typeof service.subtype == "undefined") {
        service.subtype = 0;
    }
    switch (service.UUID) {
        case Service.GarageDoorOpener.UUID : {
            // Garage door history
            // entry.time => unix time in seconds
            // entry.status => 1 = open, 0 = closed
            historyEntry.status = entry.status;
            if (typeof entry.restart != "undefined") historyEntry.restart = entry.restart;
            this.__addEntry(service.UUID, service.subtype, entry.time, historyEntry);
            break;
        }

        case Service.Window.UUID :
        case Service.WindowCovering.UUID : {
            // Window and Window Covering history
            // entry.time => unix time in seconds
            // entry.status => 1 = open, 0 = closed
            // entry.position => position %
            historyEntry.status = entry.status;
            historyEntry.position = entry.position;
            if (typeof entry.restart != "undefined") historyEntry.restart = entry.restart;
            this.__addEntry(service.UUID, service.subtype, entry.time, historyEntry);
            break;
        }

        case Service.HeaterCooler.UUID :
        case Service.Thermostat.UUID : {
            // Thermostat and Heater/Cooler history
            // entry.time => unix time in seconds
            // entry.status => 0 = off, 1 = fan, 2 = heating, 3 = cooling
            // entry.temperature  => current temperature in degress C
            // entry.target => {low, high} = cooling limit, heating limit
            // entry.humidity => current humidity
            historyEntry.status = entry.status;
            historyEntry.temperature = entry.temperature;
            historyEntry.target = entry.target;
            historyEntry.humidity = entry.humidity;
            if (typeof entry.restart != "undefined") historyEntry.restart = entry.restart;
            this.__addEntry(service.UUID, service.subtype, entry.time, historyEntry);
            break;
        }

        case Service.TemperatureSensor.UUID : {
            // Temperature sensor history
            // entry.time => unix time in seconds
            // entry.temperature => current temperature in degress C
            // entry.humidity => current humidity
            historyEntry.temperature = entry.temperature;
            if (typeof entry.humidity == "undefined") {
                // fill out humidity if missing
                entry.humidity = 0;
            }
            historyEntry.humidity = entry.humidity;
            if (typeof entry.restart != "undefined") historyEntry.restart = entry.restart;
            this.__addEntry(service.UUID, service.subtype, entry.time, historyEntry);
            break;
        }

        case Service.Valve.UUID : {
            // Water valve history
            // entry.time => unix time in seconds
            // entry.status => 0 = valve closed, 1 = valve opened
            // entry.water => amount of water in L's
            // entry.duration => time for water amount
            historyEntry.status = entry.status;
            historyEntry.water = entry.water;
            historyEntry.duration = entry.duration;
            if (typeof entry.restart != "undefined") historyEntry.restart = entry.restart;
            this.__addEntry(service.UUID, service.subtype, entry.time, historyEntry);
            break;
        }

        case Characteristic.WaterLevel.UUID : {
            // Water level history
            // entry.time => unix time in seconds
            // entry.level => water level as percentage
            historyEntry.level = entry.level;
            if (typeof entry.restart != "undefined") historyEntry.restart = entry.restart;
            this.__addEntry(service.UUID, 0, entry.time, historyEntry); // Characteristics dont have sub type, so we'll use 0 as it
            break;
        }

        case Service.Outlet.UUID : {
            // Power outlet
            // entry.time => unix time in seconds
            // entry.status => 0 = off, 1 = on
            // entry.volts  => current voltage in Vs
            // entry.watts  => current consumption in W's
            historyEntry.status = entry.status;
            historyEntry.volts = entry.volts;
            historyEntry.watts = entry.watts;
            if (typeof entry.restart != "undefined") historyEntry.restart = entry.restart;
            this.__addEntry(service.UUID, service.subtype, entry.time, historyEntry);
            break;
        }
    }
}

HomeKitHistory.prototype.resetHistory = function() {
    // Reset history to nothing
    this.historyData = {};
    this.historyData.reset = Math.floor(new Date() / 1000); // time history was reset
    this.historyData.rollover = 0;  // no last rollover time
    this.historyData.next = 0;      // next entry for history is at start
    this.historyData.types = [];    // no service types in history
    this.historyData.data = [];     // no history data
    storage.setItem(this.storageKey, this.historyData);
}

HomeKitHistory.prototype.rolloverHistory = function() {
    // Roll history over and start from zero.
    // We'll include an entry as to when the rollover took place
    // remove all history data after the rollover entry
    this.historyData.data.splice(this.maxEntries, this.historyData.data.length);
    this.historyData.rollover = Math.floor(new Date() / 1000);
    this.historyData.next = 0;
    this.__updateHistoryTypes();
    storage.setItem(this.storageKey, this.historyData);
}

HomeKitHistory.prototype.__addEntry = function(type, sub, time, entry) {
    var historyEntry = {};
    historyEntry.time = time;
    historyEntry.type = type;
    historyEntry.sub = sub;
    Object.entries(entry).forEach(([key, value]) => {
        if (key != "time" || key != "type" || key != "sub") {
            // Filer out events we want tyo control
            historyEntry[key] = value;
        }
    });

    // Work out where this goes in the history data array
    if (this.maxEntries != 0 && this.historyData.next >= this.maxEntries) {
        // roll over history data as we've reached the defined max entry size
        this.rolloverHistory();
    }
    this.historyData.data[this.historyData.next] = historyEntry;
    this.historyData.next++;

    // Update types we have in history. This will just be the main type and its latest location in history
    var typeIndex = this.historyData.types.findIndex(type => (type.type == historyEntry.type && type.sub == historyEntry.sub));
    if (typeIndex == -1) {
        this.historyData.types.push({type: historyEntry.type, sub: historyEntry.sub, lastEntry: (this.historyData.next - 1)});
    } else {
        this.historyData.types[typeIndex].lastEntry = (this.historyData.next - 1);
    }

    // Validate types last entries. Helps with rolled over data etc. If we cannot find the type anymore, removed from known types
    this.historyData.types.forEach((typeEntry, index) => {
        if (this.historyData.data[typeEntry.lastEntry].type !== typeEntry.type) {
            // not found, so remove from known types
            this.historyData.types.splice(index, 1);
        }
    });

    storage.setItem(this.storageKey, this.historyData); // Save to persistent storage
}

HomeKitHistory.prototype.getHistory = function(service, subtype, specifickey) {
    // returns a JSON object of all history for this service and subtype
    // handles if we've rolled over history also
    var tempHistory = [];
    var findUUID = null;
    var findSub = null;
    if (typeof subtype != "undefined" && subtype != null) {
        findSub = subtype;
    }
    if (typeof service != "object") {
        // passed in UUID byself, rather than service object
        findUUID = service;
    }
    if (typeof service == "object" && service.hasOwnProperty("UUID") == true) {
        findUUID = service.UUID;
    }
    if (typeof service.subtype == "undefined" && typeof subtype == "undefined") {
        findSub = 0;
    }
    tempHistory = tempHistory.concat(this.historyData.data.slice(this.historyData.next, this.historyData.data.length), this.historyData.data.slice(0, this.historyData.next));
    tempHistory = tempHistory.filter(historyEntry => {
        if (specifickey && typeof specifickey == "object" && Object.keys(specifickey).length == 1) {
            // limit entry to a specifc key type value if specified
            if ((findSub == null && historyEntry.type == findUUID && historyEntry[Object.keys(specifickey)] == Object.values(specifickey)) || (findSub != null && historyEntry.type == findUUID && historyEntry.sub == findSub && historyEntry[Object.keys(specifickey)] == Object.values(specifickey))) {
                return historyEntry;
            }
        } else if ((findSub == null && historyEntry.type == findUUID) || (findSub != null && historyEntry.type == findUUID && historyEntry.sub == findSub)) {
            return historyEntry;
        }
    });
    return tempHistory;
}

HomeKitHistory.prototype.generateCSV = function(service, csvfile) {
    // Generates a CSV file for use in applications such as Numbers/Excel for graphing
    // we get all the data for the service, ignoring the specific subtypes
    var tempHistory = this.getHistory(service, null); // all history
    if (tempHistory.length != 0) {
        var writer = fs.createWriteStream(csvfile, {flags: "w", autoClose: "true"});
        if (writer != null) {
            // write header, we'll use the first record keys for the header keys
            var header = "time,subtype";
            Object.keys(tempHistory[0]).forEach(key => {
                if (key != "time" && key != "type" && key != "sub" && key != "restart") {
                    header = header + "," + key;
                }
            });
            writer.write(header + "\n");

            // write data
            // Date/Time converted into local timezone
            tempHistory.forEach(historyEntry => {
                var csvline = new Date(historyEntry.time * 1000).toLocaleString().replace(",", "") + "," + historyEntry.sub;
                Object.entries(historyEntry).forEach(([key, value]) => {
                    if (key != "time" && key != "type" && key != "sub" && key != "restart") {
                        csvline = csvline + "," + value;
                    }
                });
                writer.write(csvline + "\n");
            });
            writer.end();
        }
    }
}

HomeKitHistory.prototype.lastHistory = function(service, subtype) {
    // returns the last history event for this service type and subtype
    var findUUID = null;
    var findSub = null;
    if (typeof subtype != "undefined") {
        findSub = subtype;
    }
    if (typeof service != "object") {
        // passed in UUID byself, rather than service object
        findUUID = service;
    }
    if (typeof service == "object" && service.hasOwnProperty("UUID") == true) {
        findUUID = service.UUID;
    }
    if (typeof service.subtype == "undefined" && typeof subtype == "undefined") {
        findSub = 0;
    }
    var typeIndex = this.historyData.types.findIndex(type => ((type.type == findUUID && type.sub == findSub && subtype != null) || (type.type == findUUID && subtype == null)));
    return (typeIndex != -1 ? this.historyData.data[this.historyData.types[typeIndex].lastEntry] : null);
}

HomeKitHistory.prototype.entryCount = function(service, subtype, specifickey) {
    // returns the number of history entries for this service type and subtype
    // can can also limit to a specific key value
    var tempHistory = this.getHistory(service, subtype, specifickey);
    return tempHistory.length;
}

HomeKitHistory.prototype.__updateHistoryTypes = function() {
    // Builds the known history types and last entry in current history data
    // Might be time consuming.....
    this.historyData.types = [];
    for (var index = (this.historyData.data.length - 1); index > 0; index--) {
        if (this.historyData.types.findIndex(type => ((typeof type.sub != "undefined" && type.type == this.historyData.data[index].type && type.sub == this.historyData.data[index].sub) || (typeof type.sub == "undefined" && type.type == this.historyData.data[index].type))) == -1) {
            this.historyData.types.push({type: this.historyData.data[index].type, sub: this.historyData.data[index].sub, lastEntry: index});
        }
    }
}



// Overlay EveHome service, characteristics and functions
// Alot of code taken from fakegato https://github.com/simont77/fakegato-history
var hexToBase64 = function (val) {
	return new Buffer(('' + val).replace(/[^0-9A-F]/ig, ''), 'hex').toString('base64');
}

var base64ToHex = function (val) {
	if (!val)
		return val;
	return new Buffer(val, 'base64').toString('hex');
}

var	swap16 = function (val) {
	return ((val & 0xFF) << 8)
		| ((val >>> 8) & 0xFF);
}

var swap32 = function (val) {
	return ((val & 0xFF) << 24)
		| ((val & 0xFF00) << 8)
		| ((val >>> 8) & 0xFF00)
		| ((val >>> 24) & 0xFF);
}

var numToHex = function (val, len) {
	var s = Number(val >>> 0).toString(16);
	if (s.length % 2 != 0) {
		s = '0' + s;
	}
	if (len) {
		return ('0000000000000' + s).slice(-1 * len);
	}
	return s;
}

HomeKitHistory.prototype.linkToEveHome = function(HomeKitAccessory, service) {
    // Overlay our history into EveHome. Can only have one service history exposed to EveHome (ATM... see if can work around)
    if (typeof this.EveHome == "undefined" || (this.EveHome && this.EveHome.hasOwnProperty("service") == false)) {
        this.EveHome = {};  // initialise our object for tracking data to EveHome
        var tempService = HomeKitAccessory.addService(Service.EveHomeHistory, "", 1);

        var tempHistory = this.getHistory(service.UUID, service.subtype);
        var historyreftime = (tempHistory.length == 0 ? (this.historyData.reset - EPOCH_OFFSET) : (tempHistory[0].time - EPOCH_OFFSET));
        var entrycount = tempHistory.length;
    
        switch (service.UUID) {
            case Service.Door.UUID :
            case Service.Window.UUID :
            case Service.WindowCovering.UUID : 
            case Service.GarageDoorOpener.UUID : {
                // treat these as EveHome Door but with inverse status for open/closed
                this.EveHome = {service: tempService, type: service.UUID, sub: service.subtype, evetype: "door", signature1: "01 0601", signature2: "01", transfer: false, entry: 0, count: entrycount, reftime: historyreftime, send: 0};
                service.addCharacteristic(Characteristic.EveLastActivation);
                service.addCharacteristic(Characteristic.EveOpenDuration);
                service.addCharacteristic(Characteristic.EveClosedDuration);
                service.addCharacteristic(Characteristic.EveTimesOpened);

                // Perform initial update to characteritics
                service.getCharacteristic(Characteristic.EveTimesOpened).updateValue(this.entryCount(this.EveHome.type, this.EveHome.sub, {status: 1}));   // Count of entries based upon status = 1, opened
            
                // calculate time in seconds since first event to last event. If no history we'll use the current time as the last event time
                var lastTime = Math.floor(new Date() / 1000) - (this.EveHome.reftime + EPOCH_OFFSET);
                if (tempHistory.length != 0) {
                    lastTime -= (Math.floor(new Date() / 1000) - tempHistory[tempHistory.length - 1].time);
                }
                service.getCharacteristic(Characteristic.EveLastActivation).updateValue(lastTime);

                // Setup some callbacks for Characteristics we want to report back on
                service.getCharacteristic(Characteristic.EveTimesOpened).on("get", (callback) => {
                    // Count of entries based upon status = 1, opened
                    callback(null, this.entryCount(this.EveHome.type, this.EveHome.sub, {status: 1}));
                });

                service.getCharacteristic(Characteristic.EveLastActivation).on("get", (callback) => {
                    // calculate time in seconds since first event to last event. If no history we'll use the current time as the last event time
                    var historyEntry = this.lastHistory(this.EveHome.type, this.EveHome.sub);
                    var lastTime = Math.floor(new Date() / 1000) - (this.EveHome.reftime + EPOCH_OFFSET);
                    if (historyEntry && Object.keys(historyEntry).length != 0) {
                        lastTime -= (Math.floor(new Date() / 1000) - historyEntry.time);
                    }
                    callback(null, lastTime);
                });
                break;
            }

            case Service.ContactSensor.UUID : {
                // treat these as EveHome Door 
                this.EveHome = {service: tempService, type: service.UUID, sub: service.subtype, evetype: "contact", signature1: "01 0601", signature2: "01", transfer: false, entry: 0, count: entrycount, reftime: historyreftime, send: 0};
                service.addCharacteristic(Characteristic.EveLastActivation);
                service.addCharacteristic(Characteristic.EveOpenDuration);
                service.addCharacteristic(Characteristic.EveClosedDuration);
                service.addCharacteristic(Characteristic.EveTimesOpened);

                // Perform initial update to characteritics
                service.getCharacteristic(Characteristic.EveTimesOpened).updateValue(this.entryCount(this.EveHome.type, this.EveHome.sub, {status: 1}));   // Count of entries based upon status = 1, opened
                
                // calculate time in seconds since first event to last event. If no history we'll use the current time as the last event time
                var lastTime = Math.floor(new Date() / 1000) - (this.EveHome.reftime + EPOCH_OFFSET);
                if (tempHistory.length != 0) {
                    lastTime -= (Math.floor(new Date() / 1000) - tempHistory[tempHistory.length - 1].time);
                }
                service.getCharacteristic(Characteristic.EveLastActivation).updateValue(lastTime);

                // Setup some callbacks for Characteristics we want to report back on
                service.getCharacteristic(Characteristic.EveTimesOpened).on("get", (callback) => {
                    // Count of entries based upon status = 1, opened
                    callback(null, this.entryCount(this.EveHome.type, this.EveHome.sub, {status: 1}));
                });

                service.getCharacteristic(Characteristic.EveLastActivation).on("get", (callback) => {
                    // calculate time in seconds since first event to last event. If no history we'll use the current time as the last event time
                    var historyEntry = this.lastHistory(this.EveHome.type, this.EveHome.sub);
                    var lastTime = Math.floor(new Date() / 1000) - (this.EveHome.reftime + EPOCH_OFFSET);
                    if (historyEntry && Object.keys(historyEntry).length != 0) {
                        lastTime -= (Math.floor(new Date() / 1000) - historyEntry.time);
                    }
                    callback(null, lastTime);
                });        
                break;
            }

            case Service.HeaterCooler.UUID :
            case Service.Thermostat.UUID : {
                // treat these as EveHome Thermo
                this.EveHome = {service: tempService, type: service.UUID, sub: service.subtype, evetype: "thermo", signature1: "05 0102 1102 1001 1201 1d01", signature2: "1f", transfer: false, entry: 0, count: entrycount, reftime: historyreftime, send: 0}; 
                service.addCharacteristic(Characteristic.EveValvePosition);   // Needed to show history for thermostating heating modes (valve position)
               /* service.addCharacteristic(Characteristic.EveProgramCommand);
                service.addCharacteristic(Characteristic.EveProgramData);

                service.getCharacteristic(Characteristic.EveProgramData).on("get", (callback) => {
                    callback(null, "ff04f6");   // Schedule disabled
                })

                service.getCharacteristic(Characteristic.EveProgramCommand).on("set", (value, callback) => {
                    callback(null,value);
                }) */
                break;
            }

            case Service.TemperatureSensor.UUID : {
                // treat these as EveHome Room
                this.EveHome = {service: tempService, type: service.UUID, sub: service.subtype, evetype: "room", signature1: "04 0102 0202 0402 0f03", signature2: "0f", transfer: false, entry: 0, count: entrycount, reftime: historyreftime, send: 0};
                service.addCharacteristic(Characteristic.TemperatureDisplayUnits); // Needed to show history for temperatue
                break;
            }

            case Service.Valve.UUID : {
                // treat these as EveHome Aqua
                // for a specific valve
                this.EveHome = {service: tempService, type: service.UUID, sub: service.subtype, evetype: "aqua", signature1: "03 1f01 2a08 2302", signature2: "05", signature3: "07", transfer: false, entry: 0, count: entrycount, reftime: historyreftime, send: 0};
                //service.addCharacteristic(Characteristic.EveAquaStatus);
                //service.addCharacteristic(Characteristic.EveAquaCommand);
                break;
            }

            case Service.IrrigationSystem.UUID : {
                // treat an irrigation system as EveHome Aqua
                // Under this, any valve history will be presented under this. We dont log our History under irrigation service ID at all
                this.EveHome = {service: tempService, type: Service.Valve.UUID, sub: null, evetype: "aqua", signature1: "03 1f01 2a08 2302", signature2: "05", signature3: "07", transfer: false, entry: 0, count: entrycount, reftime: historyreftime, send: 0};  
                //service.addCharacteristic(Characteristic.EveAquaStatus);
                //service.addCharacteristic(Characteristic.EveAquaCommand);
                break;
            }

            case Service.Outlet.UUID : {
                // treat these as EveHome energy
                this.EveHome = {service: tempService, type: service.UUID, sub: service.subtype, evetype: "energy", signature1: "04 0102 0202 0702 0f03", signature2: "1f", transfer: false, entry: 0, count: entrycount, reftime: historyreftime, send: 0}; 
                service.addCharacteristic(Characteristic.EveVoltage);
                service.addCharacteristic(Characteristic.EveElectricCurrent);
                service.addCharacteristic(Characteristic.EveCurrentConsumption);
                service.addCharacteristic(Characteristic.EveTotalConsumption);

                // Setup some callbacks for Characteristics we want to report back on
                service.getCharacteristic(Characteristic.EveCurrentConsumption).on("get", (callback) => {
                    var historyEntry = this.lastHistory(this.EveHome.type, this.EveHome.sub);
                    var lastWatts = null;
                    if (historyEntry && Object.keys(historyEntry).length != 0) {
                        lastWatts = historyEntry.watts;
                    }
                    callback(null, lastWatts);
                });
                break;
            }
        }
    
        // Setup callbacks
        this.EveHome.service.getCharacteristic(Characteristic.EveResetTotal).on("get", (callback) => {callback(null, this.historyData.reset - EPOCH_OFFSET)});   // time since history reset
        this.EveHome.service.getCharacteristic(Characteristic.EveHistoryStatus).on("get", this.__EveHistoryStatus.bind(this));
        this.EveHome.service.getCharacteristic(Characteristic.EveHistoryEntries).on("get", this.__EveHistoryEntries.bind(this));
        this.EveHome.service.getCharacteristic(Characteristic.EveHistoryRequest).on("set", this.__EveHistoryRequest.bind(this));
        this.EveHome.service.getCharacteristic(Characteristic.EveSetTime).on("set", this.__EveSetTime.bind(this));
    }
}

HomeKitHistory.prototype.__EveLastEventTime = function() {
    // calculate time in seconds since first event to last event. If no history we'll use the current time as the last event time
    var historyEntry = this.lastHistory(this.EveHome.type, this.EveHome.sub);
    var lastTime = Math.floor(new Date() / 1000) - (this.EveHome.reftime + EPOCH_OFFSET);
    if (historyEntry && Object.keys(historyEntry).length != 0) {
        lastTime -= (Math.floor(new Date() / 1000) - historyEntry.time);
    }
    return lastTime;
}

HomeKitHistory.prototype.__EveHistoryStatus = function(callback) {
    var tempHistory = this.getHistory(this.EveHome.type, this.EveHome.sub); // get flattened history array for easier processing
    var historyTime = (tempHistory.length == 0 ? Math.floor(new Date() / 1000) : tempHistory[tempHistory.length - 1].time);
    this.EveHome.reftime = (tempHistory.length == 0 ? (this.historyData.reset - EPOCH_OFFSET) : (tempHistory[0].time - EPOCH_OFFSET));
    this.EveHome.count = tempHistory.length;

    var value = hexToBase64(util.format(
        '%s 00000000 %s %s %s %s %s 000000000101',
        numToHex(swap32(historyTime - this.EveHome.reftime - EPOCH_OFFSET), 8),
        numToHex(swap32(this.EveHome.reftime), 8), // reference time (time of first history??)
        this.EveHome.signature1,
        numToHex(swap16(this.EveHome.count), 4), // count of entries
        numToHex(swap16((this.maxEntries == 0 ? MAX_HISTORY_SIZE : this.maxEntries)), 4),  // history max size
        numToHex(swap32(1), 8)));  // first entry

    callback(null, value);
}

HomeKitHistory.prototype.__EveHistoryEntries = function(callback) {
    // Streams our history data back to EveHome when requested
    if (this.EveHome.entry <= this.EveHome.count && this.EveHome.transfer == true) {
        var dataStream = "";
        var tempHistory = this.getHistory(this.EveHome.type, this.EveHome.sub); // get flattened history array for easier processing

        dataStream += util.format(
            " 15 %s 0100 0000 81 %s 0000 0000 00 0000",
            numToHex(swap32(this.EveHome.entry), 8),
            numToHex(swap32(this.EveHome.reftime), 8)); // not sure this is actually needed

        for (var i = 0; i < EVEHOME_MAX_STREAM; i++) {
            if (tempHistory.length != 0 && (this.EveHome.entry - 1) <= tempHistory.length) {
                historyEntry = tempHistory[this.EveHome.entry - 1]; // need to map EveHome entry address to our data history, as EvenHome addreses start at 1
                switch (this.EveHome.evetype) {
                    case "aqua" : {
                        if (historyEntry.status == 1)  {
                            // Valve opened
                            dataStream += util.format(
                                " 0d %s %s %s %s 300c",
                                numToHex(swap32(this.EveHome.entry), 8),
                                numToHex(swap32(historyEntry.time - this.EveHome.reftime - EPOCH_OFFSET), 8),
                                this.EveHome.signature2,
                                numToHex(historyEntry.status, 2));
                        } else {
                            // Valve closed
                            dataStream += util.format(
                                " 15 %s %s %s %s %s 00000000 300c",
                                numToHex(swap32(this.EveHome.entry), 8),
                                numToHex(swap32(historyEntry.time - this.EveHome.reftime - EPOCH_OFFSET), 8),
                                this.EveHome.signature3,
                                numToHex(historyEntry.status, 2),
                                numToHex(swap32(historyEntry.amount * 1000), 8)); // in millilitres
                        }
                        break;
                    }

                    case "room": {
                        dataStream += util.format(
                            " 13 %s %s %s %s %s %s 0000 00",
                            numToHex(swap32(this.EveHome.entry), 8),
                            numToHex(swap32(historyEntry.time - this.EveHome.reftime - EPOCH_OFFSET), 8),
                            this.EveHome.signature2,
                            numToHex(swap16(historyEntry.temperature * 100), 4), // temperature
                            numToHex(swap16(historyEntry.humidity * 100), 4), // Humidity
                            numToHex(swap16((historyEntry.hasOwnProperty("ppm") ? historyEntry.ppm * 10 : 10)), 4)); // PPM - air quality
                        break;
                    }

                    case "weather": {
                        dataStream += util.format(
                            " 10 %s %s %s %s %s %s",
                            numToHex(swap32(this.EveHome.entry), 8),
                            numToHex(swap32(historyEntry.time - this.EveHome.reftime - EPOCH_OFFSET), 8),
                            this.EveHome.signature2,
                            numToHex(swap16(historyEntry.temperature * 100), 4), // temperature
                            numToHex(swap16(historyEntry.humidity * 100), 4), // Humidity
                            numToHex(swap16((historyEntry.hasOwnProperty("pressure") ? historyEntry.pressure * 10 : 10)), 4)); // Pressure
                        break;
                    }

                    case "contact" : {
                        dataStream += util.format(
                            " 0b %s %s %s %s",
                            numToHex(swap32(this.EveHome.entry), 8),
                            numToHex(swap32(historyEntry.time - this.EveHome.reftime - EPOCH_OFFSET), 8),
                            this.EveHome.signature2,
                            numToHex(historyEntry.status, 2));    // 0 = Contact detected, 1 = no contact detected
                        break;
                    }

                    case "door" : {
                        // Invert status for EveHome. As EveHome door is a contact sensor, where 1 is contact and 0 is no contact, opposite of what we expect a door to be
                        // ie: 0 = closed, 1 = opened
                        dataStream += util.format(
                            " 0b %s %s %s %s",
                            numToHex(swap32(this.EveHome.entry), 8),
                            numToHex(swap32(historyEntry.time - this.EveHome.reftime - EPOCH_OFFSET), 8),
                            this.EveHome.signature2,
                            numToHex(!historyEntry.status, 2));  // status for EveHome (inverted ie: 1 = closed, 0 = opened)
                        break;
                    }

                    case "thermo" : {
                        var tempTarget = 0;
                        if (historyEntry.low == 0 && historyEntry.high != 0) tempTarget = historyEntry.target.high;   // heating limit
                        if (historyEntry.low != 0 && historyEntry.high != 0) tempTarget = historyEntry.target.high;   // range, so using heating limit
                        if (historyEntry.low != 0 && historyEntry.high == 0) tempTarget = 0;   // cooling limit
                        if (historyEntry.low == 0 && historyEntry.high == 0) tempTarget = 0;   // off

                        dataStream += util.format(
                            " 11 %s %s %s %s %s %s 0000",
                            numToHex(swap32(this.EveHome.entry), 8),
                            numToHex(swap32(historyEntry.time - this.EveHome.reftime - EPOCH_OFFSET), 8),
                            this.EveHome.signature2,
                            numToHex(swap16(historyEntry.temperature * 100), 4), // temperature
                            numToHex(swap16(tempTarget * 100), 4), // target temperature for heating
                            numToHex((historyEntry.status == 2 ? 100 : 0), 2)); // 0% valve position = off, 100% = heating
                            //numToHex((historyEntry.status == 2 ? 100 : historyEntry.status == 1 ? 0 : 50), 2)); // 50% valve position = off, 0% = cooling, 100% = heating
                        break;
                    }

                    case "energy" : {
                        dataStream += util.format(
                            " 14 %s %s %s 0000 0000 %s 0000 0000",
                            numToHex(swap32(this.EveHome.entry), 8),
                            numToHex(swap32(historyEntry.time - this.EveHome.reftime - EPOCH_OFFSET), 8),
                            this.EveHome.signature2,
                            numToHex(swap16(historyEntry.watts * 10), 4));  // Power in watts
                        break;
                    }
                }
                this.EveHome.entry++;    
                if (this.EveHome.entry > this.EveHome.count) break;
            }
        }
        if (this.EveHome.entry > this.EveHome.count) {
            // No more history data to send back
            dataStream += " 00";
            console.log("DEBUG: __EveHistoryEntries: sent '%s' entries to EveHome ('%s') for '%s:%s'", this.EveHome.send, this.EveHome.evetype, this.EveHome.type, this.EveHome.sub);
            this.EveHome.send = 0;
            this.EveHome.transfer = false;
        }
        callback(null, hexToBase64(dataStream));
    } else {
         // We're not transferring any data back
        this.EveHome.transfer = false;
        this.EveHome.send = 0;
        callback(null, hexToBase64('00'));
        console.log("DEBUG: __EveHistoryEntries: do we every get here.....???");
    }
}

HomeKitHistory.prototype.__EveHistoryRequest = function(value, callback) {
    // Requesting history, starting at specific entry
    this.EveHome.transfer = true;
    this.EveHome.entry = parseInt(swap32(parseInt(base64ToHex(value).substring(4, 12), 16)).toString('16'), 16);    // Starting entry
    if (this.EveHome.entry == 0) {
        this.EveHome.entry = 1; // requested to restart from beginning of history for sending to EveHome
    }
    this.EveHome.send = (this.EveHome.count - this.EveHome.entry + 1);    // Number of entries we're expected to send
    callback(null, value);
    //console.log("DEBUG: __EveHistoryRequest: requested address", this.EveHome.entry);
}

HomeKitHistory.prototype.__EveSetTime = function(value, callback) {
    // Time stamp from EveHome
    var tempEntry = new Date((EPOCH_OFFSET + swap32(parseInt(base64ToHex(value), 16))) * 1000);
    callback(null, value);
    //console.log("DEBUG: __EveSetTime: timestamp offset", tempEntry);
}

// Eve Reset Total
Characteristic.EveResetTotal = function () {
	Characteristic.call(this, "Eve Reset Total", "E863F112-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: Characteristic.Formats.UINT32,
        unit: Characteristic.Units.SECONDS, // since 2001/01/01
		perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY, Characteristic.Perms.WRITE]
	});
	this.value = this.getDefaultValue();
}
util.inherits(Characteristic.EveResetTotal, Characteristic);
Characteristic.EveResetTotal.UUID = "E863F112-079E-48FF-8F27-9C2605A29F52";

// EveHistoryStatus
Characteristic.EveHistoryStatus = function () {
	Characteristic.call(this, "Eve History Status", "E863F116-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: Characteristic.Formats.DATA,
		perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY, Characteristic.Perms.HIDDEN]
	});
	this.value = this.getDefaultValue();
}
util.inherits(Characteristic.EveHistoryStatus, Characteristic);
Characteristic.EveHistoryStatus.UUID = "E863F116-079E-48FF-8F27-9C2605A29F52";

// EveHistoryEntries
Characteristic.EveHistoryEntries = function () {
	Characteristic.call(this, "Eve History Entries", "E863F117-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: Characteristic.Formats.DATA,
		perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY, Characteristic.Perms.HIDDEN]
	});
	this.value = this.getDefaultValue();
}
util.inherits(Characteristic.EveHistoryEntries, Characteristic);
Characteristic.EveHistoryEntries.UUID = "E863F117-079E-48FF-8F27-9C2605A29F52";

// EveHistoryRequest
Characteristic.EveHistoryRequest = function () {
	Characteristic.call(this, "Eve History Request", "E863F11C-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: Characteristic.Formats.DATA,
		perms: [Characteristic.Perms.WRITE, Characteristic.Perms.HIDDEN]
	});
	this.value = this.getDefaultValue();
}
util.inherits(Characteristic.EveHistoryRequest, Characteristic);
Characteristic.EveHistoryRequest.UUID = "E863F11C-079E-48FF-8F27-9C2605A29F52";

// EveSetTime
Characteristic.EveSetTime = function () {
	Characteristic.call(this, "EveHome SetTime", "E863F121-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: Characteristic.Formats.DATA,
		perms: [Characteristic.Perms.WRITE, Characteristic.Perms.HIDDEN]
	});
	this.value = this.getDefaultValue();
}
util.inherits(Characteristic.EveSetTime, Characteristic);
Characteristic.EveSetTime.UUID = "E863F121-079E-48FF-8F27-9C2605A29F52";

// Valve Position.. Added to Thermo type accessories
Characteristic.EveValvePosition = function () {
	Characteristic.call(this, "Eve Valve Position", "E863F12E-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: Characteristic.Formats.UINT8,
        unit: Characteristic.Units.PERCENTAGE,
        perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
	});
	this.value = this.getDefaultValue();
}
util.inherits(Characteristic.EveValvePosition, Characteristic);
Characteristic.EveValvePosition.UUID = "E863F12E-079E-48FF-8F27-9C2605A29F52";

Characteristic.EveLastActivation = function () {
	Characteristic.call(this, "Eve Last Activation", "E863F11A-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: Characteristic.Formats.UINT32,
        unit: Characteristic.Units.SECONDS,
        perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
	});
	this.value = this.getDefaultValue();
}
util.inherits(Characteristic.EveLastActivation, Characteristic);
Characteristic.EveLastActivation.UUID = "E863F11A-079E-48FF-8F27-9C2605A29F52";

Characteristic.EveTimesOpened = function () {
	Characteristic.call(this, "Eve Times Opened", "E863F129-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: Characteristic.Formats.UINT32,
        perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
	});
	this.value = this.getDefaultValue();
}
util.inherits(Characteristic.EveTimesOpened, Characteristic);
Characteristic.EveTimesOpened.UUID = "E863F129-079E-48FF-8F27-9C2605A29F52";

Characteristic.EveClosedDuration = function () {
	Characteristic.call(this, "Eve Closed Duration", "E863F118-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: Characteristic.Formats.UINT32,
        perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
	});
	this.value = this.getDefaultValue();
}
util.inherits(Characteristic.EveClosedDuration, Characteristic);
Characteristic.EveClosedDuration.UUID = "E863F118-079E-48FF-8F27-9C2605A29F52";

Characteristic.EveOpenDuration = function () {
	Characteristic.call(this, "Eve Opened Duration", "E863F119-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: Characteristic.Formats.UINT32,
        perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
	});
	this.value = this.getDefaultValue();
}
util.inherits(Characteristic.EveOpenDuration, Characteristic);
Characteristic.EveOpenDuration.UUID = "E863F119-079E-48FF-8F27-9C2605A29F52";

Characteristic.EveProgramCommand = function () {
	Characteristic.call(this, "Eve Program Command", "E863F12C-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: Characteristic.Formats.DATA,
        perms: [Characteristic.Perms.WRITE]
	});
	this.value = this.getDefaultValue();
}
util.inherits(Characteristic.EveProgramCommand, Characteristic);
Characteristic.EveProgramCommand.UUID = "E863F12C-079E-48FF-8F27-9C2605A29F52";

Characteristic.EveProgramData = function () {
	Characteristic.call(this, "Eve Program Data", "E863F12F-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: Characteristic.Formats.DATA,
        perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
	});
	this.value = this.getDefaultValue();
}
util.inherits(Characteristic.EveProgramData, Characteristic);
Characteristic.EveProgramData.UUID = "E863F12F-079E-48FF-8F27-9C2605A29F52";

Characteristic.EveVoltage = function () {
	Characteristic.call(this, "Eve Voltage", "E863F10A-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: Characteristic.Formats.FLOAT,
        unit: 'V',
        perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
	});
	this.value = this.getDefaultValue();
}
util.inherits(Characteristic.EveVoltage, Characteristic);
Characteristic.EveVoltage.UUID = "E863F10A-079E-48FF-8F27-9C2605A29F52";

Characteristic.EveElectricCurrent = function () {
	Characteristic.call(this, "Eve Electric Current", "E863F126-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: Characteristic.Formats.FLOAT,
        unit: 'A',
        perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
	});
	this.value = this.getDefaultValue();
}
util.inherits(Characteristic.EveElectricCurrent, Characteristic);
Characteristic.EveElectricCurrent.UUID = "E863F126-079E-48FF-8F27-9C2605A29F52";

Characteristic.EveTotalConsumption = function () {
	Characteristic.call(this, "Eve Total Consumption", "E863F10C-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: Characteristic.Formats.FLOAT,
        unit: 'kWh',
        perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
	});
	this.value = this.getDefaultValue();
}
util.inherits(Characteristic.EveTotalConsumption, Characteristic);
Characteristic.EveTotalConsumption.UUID = "E863F10C-079E-48FF-8F27-9C2605A29F52";

Characteristic.EveCurrentConsumption = function () {
	Characteristic.call(this, "Eve Current Consumption", "E863F10D-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: Characteristic.Formats.FLOAT,
        unit: 'W',
        perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
	});
	this.value = this.getDefaultValue();
}
util.inherits(Characteristic.EveCurrentConsumption, Characteristic);
Characteristic.EveCurrentConsumption.UUID = "E863F10D-079E-48FF-8F27-9C2605A29F52";

Characteristic.EveAquaStatus = function () {
	Characteristic.call(this, "Eve Aqua Status", "E863F131-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: Characteristic.Formats.DATA,
        perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
	});
	this.value = this.getDefaultValue();
}
util.inherits(Characteristic.EveAquaStatus, Characteristic);
Characteristic.EveAquaStatus.UUID = "E863F131-079E-48FF-8F27-9C2605A29F52";

Characteristic.EveAquaCommand = function () {
	Characteristic.call(this, "Eve Aqua Command", "E863F11D-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: Characteristic.Formats.DATA,
        perms: [Characteristic.Perms.WRITE, Characteristic.Perms.HIDDEN]
	});
	this.value = this.getDefaultValue();
}
util.inherits(Characteristic.EveAquaCommand, Characteristic);
Characteristic.EveAquaCommand.UUID = "E863F11D-079E-48FF-8F27-9C2605A29F52";

// EveHomeHistory Service
Service.EveHomeHistory = function(displayName, subtype) {
	Service.call(this, displayName, "E863F007-079E-48FF-8F27-9C2605A29F52", subtype);

    // Required Characteristics
    this.addCharacteristic(Characteristic.EveResetTotal);
    this.addCharacteristic(Characteristic.EveHistoryStatus);
    this.addCharacteristic(Characteristic.EveHistoryEntries);
    this.addCharacteristic(Characteristic.EveHistoryRequest);
    this.addCharacteristic(Characteristic.EveSetTime);
}
util.inherits(Service.EveHomeHistory, Service);
Service.EveHomeHistory.UUID = "E863F007-079E-48FF-8F27-9C2605A29F52";

module.exports = HomeKitHistory;
