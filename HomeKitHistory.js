// HomeKit history service
// Simple history service for HomeKit developed accessories with HAP-NodeJS
//
// todo
// -- get humidity recordings for EveHome thermo
// -- get history to show for EveHome motion when attached to a smoke sensor
// -- doorbell button press hsitory to show
//
// done
// -- initial support for importing our history into EveHome
// -- developed simple history service for HomeKit HAP-NodeJS accessories
// -- import history for sprinkler/irrigation systems to EveHome (Aqua)
// -- fixed door history bug with inverted status
// -- notify Eve when new history entries added
//
// bugs
// -- when motion sensor paired with smoke service, EveHome thinks its an Eve Smoke, but no motion history shows
//
// Version 25/8/2020
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

        case Service.MotionSensor.UUID : {
            // Motion sensor history
            // entry.time => unix time in seconds
            // entry.status => 1 = motion detected, 0 = motion cleared
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
            // entry.position => position in % 0% = closed 100% fully open
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

        case Service.Doorbell.UUID : {
            // Motion sensor history
            // entry.time => unix time in seconds
            // entry.status => 1 = doorbell pressed, 0 = not pressed
            historyEntry.status = entry.status;
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

    // If subtype is "null" find newest event based on time
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
// references from https://github.com/ebaauw/homebridge-lib/blob/master/lib/EveHomeKitTypes.js
//
var encodeEveData = function (string) {
	return Buffer.from(('' + string).replace(/[^a-fA-F0-9]/ig, ''), 'hex').toString('base64');
}

var decodeEveData = function (data) {
    if (typeof data != "string") return data;
	return Buffer.from(data, 'base64').toString('hex');
}

// Converts a number into a string for EveHome, including formatting to byte width and reverse byte order
// handles upto 64bit values
var numberToEveHexString = function (number, bytes) {
    if (typeof number != "number") return number;
    var tempString = '0000000000000000' + number.toString(16);
    tempString = tempString.slice(-1 * bytes).match(/[a-fA-F0-9]{2}/g).reverse().join('');
    return tempString;
}

// Converts Eve encoded hex string to number
var EveHexStringToNumber = function (string) {
    if (typeof string != "string") return string;
    var tempString = string.match(/[a-fA-F0-9]{2}/g).reverse().join('');
    return Number(`0x${tempString}`);   // convert to number on return
}

// Overlay our history into EveHome. Can only have one service history exposed to EveHome (ATM... see if can work around)
// Returns object created for our EveHome accessory if successfull
HomeKitHistory.prototype.linkToEveHome = function(HomeKitAccessory, service, optionalParams) {
    var allowReset = false;
    var processCommand = null;
    if (typeof (optionalParams) === "object") {
        allowReset = optionalParams.allowReset || false;    // Allow EveHome to reset our history (clear it)
        processCommand = optionalParams.ProcessCommand || null; // function to process set data for commands outside of this library
    }

    if (typeof this.EveHome == "undefined" || (this.EveHome && this.EveHome.hasOwnProperty("service") == false)) {
        switch (service.UUID) {
            case Service.Door.UUID :
            case Service.Window.UUID :
            case Service.WindowCovering.UUID : 
            case Service.GarageDoorOpener.UUID : {
                // treat these as EveHome Door but with inverse status for open/closed
                var historyService = HomeKitAccessory.addService(Service.EveHomeHistory, "", 1);
                var tempHistory = this.getHistory(service.UUID, service.subtype);
                var historyreftime = (tempHistory.length == 0 ? (this.historyData.reset - EPOCH_OFFSET) : (tempHistory[0].time - EPOCH_OFFSET));

                this.EveHome = {service: historyService, type: service.UUID, sub: service.subtype, evetype: "door", signature1: "01 0601", signature2: "01", entry: 0, count: tempHistory.length, reftime: historyreftime, send: 0};
                service.addCharacteristic(Characteristic.EveLastActivation);
                service.addCharacteristic(Characteristic.EveOpenDuration);
                service.addCharacteristic(Characteristic.EveClosedDuration);
                service.addCharacteristic(Characteristic.EveTimesOpened);

                // Setup initial values and callbacks for charateristics we are using
                service.getCharacteristic(Characteristic.EveTimesOpened).updateValue(this.entryCount(this.EveHome.type, this.EveHome.sub, {status: 1}));   // Count of entries based upon status = 1, opened
                service.getCharacteristic(Characteristic.EveLastActivation).updateValue(this.__EveLastEventTime()); // time of last event in seconds since first event
                service.getCharacteristic(Characteristic.EveTimesOpened).on("get", (callback) => {
                    callback(null, this.entryCount(this.EveHome.type, this.EveHome.sub, {status: 1}));  // Count of entries based upon status = 1, opened
                });
                service.getCharacteristic(Characteristic.EveLastActivation).on("get", (callback) => {
                    callback(null, this.__EveLastEventTime());  // time of last event in seconds since first event
                }); 
                break;
            }

            case Service.ContactSensor.UUID : {
                // treat these as EveHome Door
                var historyService = HomeKitAccessory.addService(Service.EveHomeHistory, "", 1);
                var tempHistory = this.getHistory(service.UUID, service.subtype);
                var historyreftime = (tempHistory.length == 0 ? (this.historyData.reset - EPOCH_OFFSET) : (tempHistory[0].time - EPOCH_OFFSET));

                this.EveHome = {service: historyService, type: service.UUID, sub: service.subtype, evetype: "contact", signature1: "01 0601", signature2: "01", entry: 0, count: tempHistory.length, reftime: historyreftime, send: 0};
                service.addCharacteristic(Characteristic.EveLastActivation);
                service.addCharacteristic(Characteristic.EveOpenDuration);
                service.addCharacteristic(Characteristic.EveClosedDuration);
                service.addCharacteristic(Characteristic.EveTimesOpened);

                // Setup initial values and callbacks for charateristics we are using
                service.getCharacteristic(Characteristic.EveTimesOpened).updateValue(this.entryCount(this.EveHome.type, this.EveHome.sub, {status: 1}));   // Count of entries based upon status = 1, opened
                service.getCharacteristic(Characteristic.EveLastActivation).updateValue(this.__EveLastEventTime()); // time of last event in seconds since first event
                service.getCharacteristic(Characteristic.EveTimesOpened).on("get", (callback) => {
                    callback(null, this.entryCount(this.EveHome.type, this.EveHome.sub, {status: 1})); // Count of entries based upon status = 1, opened
                });
                service.getCharacteristic(Characteristic.EveLastActivation).on("get", (callback) => {
                    callback(null, this.__EveLastEventTime());  // time of last event in seconds since first event
                });  
                break;
            }

            case Service.HeaterCooler.UUID :
            case Service.Thermostat.UUID : {
                // treat these as EveHome Thermo
                var historyService = HomeKitAccessory.addService(Service.EveHomeHistory, "", 1);
                var tempHistory = this.getHistory(service.UUID, service.subtype);
                var historyreftime = (tempHistory.length == 0 ? (this.historyData.reset - EPOCH_OFFSET) : (tempHistory[0].time - EPOCH_OFFSET));

                this.EveHome = {service: historyService, type: service.UUID, sub: service.subtype, evetype: "thermo", signature1: "05 0102 1102 1001 1201 1d01", signature2: "1f", entry: 0, count: tempHistory.length, reftime: historyreftime, send: 0}; 
                service.addCharacteristic(Characteristic.EveValvePosition);   // Needed to show history for thermostating heating modes (valve position)
                break;
            }

            case Service.TemperatureSensor.UUID : {
                // treat these as EveHome Room
                var historyService = HomeKitAccessory.addService(Service.EveHomeHistory, "", 1);
                var tempHistory = this.getHistory(service.UUID, service.subtype);
                var historyreftime = (tempHistory.length == 0 ? (this.historyData.reset - EPOCH_OFFSET) : (tempHistory[0].time - EPOCH_OFFSET));

                this.EveHome = {service: historyService, type: service.UUID, sub: service.subtype, evetype: "room", signature1: "04 0102 0202 0402 0f03", signature2: "0f", entry: 0, count: tempHistory.length, reftime: historyreftime, send: 0};
                service.addCharacteristic(Characteristic.TemperatureDisplayUnits); // Needed to show history for temperature
                break;
            }

            case Service.MotionSensor.UUID : {
                // treat these as EveHome Motion
                var historyService = HomeKitAccessory.addService(Service.EveHomeHistory, "", 1);
                var tempHistory = this.getHistory(service.UUID, service.subtype);
                var historyreftime = (tempHistory.length == 0 ? (this.historyData.reset - EPOCH_OFFSET) : (tempHistory[0].time - EPOCH_OFFSET));

                this.EveHome = {service: historyService, type: service.UUID, sub: service.subtype, evetype: "motion", signature1:"02 1301 1c01", signature2: "02", entry: 0, count: tempHistory.length, reftime: historyreftime, send: 0};
                service.addCharacteristic(Characteristic.EveSensitivity);
                service.addCharacteristic(Characteristic.EveDuration);
                service.addCharacteristic(Characteristic.EveLastActivation);

                // TODO - What to add if on an accessory with a Smoke service to show motion history?

                // Setup initial values and callbacks for charateristics we are using
                service.getCharacteristic(Characteristic.EveLastActivation).updateValue(this.__EveLastEventTime()); // time of last event in seconds since first event
                service.getCharacteristic(Characteristic.EveLastActivation).on("get", (callback) => {
                    callback(null, this.__EveLastEventTime());  // time of last event in seconds since first event
                });  
                break;
            }

            case Service.Valve.UUID : {
                // treat these as EveHome Aqua
                // for a specific valve
                var historyService = HomeKitAccessory.addService(Service.EveHomeHistory, "", 1);
                var tempHistory = this.getHistory(service.UUID, service.subtype);
                var historyreftime = (tempHistory.length == 0 ? (this.historyData.reset - EPOCH_OFFSET) : (tempHistory[0].time - EPOCH_OFFSET));

                this.EveHome = {service: historyService, type: service.UUID, sub: service.subtype, evetype: "aqua", signature1: "03 1f01 2a08 2302", signature2: "05", signature3: "07", entry: 0, count: tempHistory.length, reftime: historyreftime, send: 0};
                service.addCharacteristic(Characteristic.EveGetConfiguration);
                service.addCharacteristic(Characteristic.EveSetConfiguration);

                // Setup initial values and callbacks for charateristics we are using
                service.getCharacteristic(Characteristic.EveGetConfiguration).updateValue(this.__EveAquaWaterDetails());
                service.getCharacteristic(Characteristic.EveGetConfiguration).on("get", (callback) => {
                    callback(null, this.__EveAquaWaterDetails());
                }); 
                break;
            }

            case Service.IrrigationSystem.UUID : {
                // treat an irrigation system as EveHome Aqua
                // Under this, any valve history will be presented under this. We dont log our History under irrigation service ID at all

                // TODO - see if we can add history per valve service under the irrigation system????. History service per valve???
                var historyService = HomeKitAccessory.addService(Service.EveHomeHistory, "", 1);  
                var tempHistory = this.getHistory(Service.Valve.UUID, null);
                var historyreftime = (tempHistory.length == 0 ? (this.historyData.reset - EPOCH_OFFSET) : (tempHistory[0].time - EPOCH_OFFSET));
  
                this.EveHome = {service: historyService, type: Service.Valve.UUID, sub: null, evetype: "aqua", signature1: "03 1f01 2a08 2302", signature2: "05", signature3: "07", entry: 0, count: tempHistory.length, reftime: historyreftime, send: 0};
                service.addCharacteristic(Characteristic.EveGetConfiguration);
                service.addCharacteristic(Characteristic.EveSetConfiguration);

                // Setup initial values and callbacks for charateristics we are using
                service.getCharacteristic(Characteristic.EveGetConfiguration).updateValue(this.__EveAquaWaterDetails());
                service.getCharacteristic(Characteristic.EveGetConfiguration).on("get", (callback) => {
                    callback(null, this.__EveAquaWaterDetails());
                });
                service.getCharacteristic(Characteristic.EveSetConfiguration).on("set", (value, callback) => {
                    // Loop through set commands passed to us
                    var valHex = decodeEveData(value);
                    var index = 0;
                    while (index < valHex.length) {
                        // first byte is command
                        // second byte is size of data for command
                        command = valHex.substr(index, 2);
                        size = parseInt(valHex.substr(index + 2, 2), 16) * 2;
                        data = valHex.substr(index + 4, parseInt(valHex.substr(index + 2, 2), 16) * 2);

                        switch(command) {
                            case "2e" : {
                                // flow rate in ml/Minute
                                var flowrateLS = EveHexStringToNumber(data) * 60; // flow rate in ml/Minute
                                break;
                            }

                            case "2f" : {
                                // reset timestamp in seconds since EPOCH
                                var timestamp = (EPOCH_OFFSET + EveHexStringToNumber(data));
                                break;
                            }

                            default : {
                                if (typeof optionalParams.ProcessCommand == "function") optionalParams.ProcessCommand(command, data); // Send command to be processed if we havent handled it here
                                break;
                            }
                        }
                        index += 4 + size;  // Move to next command accounting for header size of 4 bytes
                    };
                    callback();
                });
                break;
            }

            case Service.Outlet.UUID : {
                // treat these as EveHome energy
                var historyService = HomeKitAccessory.addService(Service.EveHomeHistory, "", 1);  
                var tempHistory = this.getHistory(Service.Valve.UUID, null);
                var historyreftime = (tempHistory.length == 0 ? (this.historyData.reset - EPOCH_OFFSET) : (tempHistory[0].time - EPOCH_OFFSET));

                this.EveHome = {service: historyService, type: service.UUID, sub: service.subtype, evetype: "energy", signature1: "04 0102 0202 0702 0f03", signature2: "1f", entry: 0, count: tempHistory.length, reftime: historyreftime, send: 0}; 
                service.addCharacteristic(Characteristic.EveVoltage);
                service.addCharacteristic(Characteristic.EveElectricCurrent);
                service.addCharacteristic(Characteristic.EveCurrentConsumption);
                service.addCharacteristic(Characteristic.EveTotalConsumption);

                // Setup initial values and callbacks for charateristics we are using
                service.getCharacteristic(Characteristic.EveCurrentConsumption).updateValue(() => {
                    // Use last history entry for currrent power consumption
                    var historyEntry = this.lastHistory(this.EveHome.type, this.EveHome.sub);
                    var lastWatts = 0;
                    if (historyEntry && Object.keys(historyEntry).length != 0) {
                        lastWatts = historyEntry.watts;
                    }
                    return lastWatts;
                });
                service.getCharacteristic(Characteristic.EveCurrentConsumption).on("get", (callback) => {
                    // Use last history entry for currrent power consumption
                    var historyEntry = this.lastHistory(this.EveHome.type, this.EveHome.sub);
                    var lastWatts = 0;
                    if (historyEntry && Object.keys(historyEntry).length != 0) {
                        lastWatts = historyEntry.watts;
                    }
                    callback(null, lastWatts);
                });
                break;
            }
            
            case Service.Doorbell.UUID : {
                // treat these as EveHome button??
                var historyService = HomeKitAccessory.addService(Service.EveHomeHistory, "", 1);
                var tempHistory = this.getHistory(service.UUID, service.subtype);
                var historyreftime = (tempHistory.length == 0 ? (this.historyData.reset - EPOCH_OFFSET) : (tempHistory[0].time - EPOCH_OFFSET));

                this.EveHome = {service: historyService, type: service.UUID, sub: service.subtype, evetype: "switch", signature1: "01 0e01", signature2: "01", entry: 0, count: tempHistory.length, reftime: historyreftime, send: 0};
                service.addCharacteristic(Characteristic.EveLastActivation);

                // Setup initial values and callbacks for charateristics we are using
                service.getCharacteristic(Characteristic.EveLastActivation).updateValue(this.__EveLastEventTime()); // time of last event in seconds since first event
                break;
            }
        }
    
        // Setup callbacks if our service successfully created
        if (typeof this.EveHome.service != "undefined" && this.EveHome.service != null) {
            this.EveHome.service.getCharacteristic(Characteristic.EveResetTotal).on("get", (callback) => {callback(null, this.historyData.reset - EPOCH_OFFSET)});   // time since history reset
            this.EveHome.service.getCharacteristic(Characteristic.EveHistoryStatus).on("get", this.__EveHistoryStatus.bind(this));
            this.EveHome.service.getCharacteristic(Characteristic.EveHistoryEntries).on("get", this.__EveHistoryEntries.bind(this));
            this.EveHome.service.getCharacteristic(Characteristic.EveHistoryRequest).on("set", this.__EveHistoryRequest.bind(this));
            this.EveHome.service.getCharacteristic(Characteristic.EveSetTime).on("set", this.__EveSetTime.bind(this));

            return this.EveHome.service;    // Return service handle for our EveHome accessory service
        }
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

HomeKitHistory.prototype.__EveAquaWaterDetails = function() {
    // returns an encoded value formatted for an Eve Aqua device for water usage and last water time
    // todo encode schedules if set and water flow rate
    var tempHistory = this.getHistory(this.EveHome.type, this.EveHome.sub); // get flattened history array for easier processing

    // Calculate total water usage over history period
    var totalWater = 0;
    tempHistory.forEach(historyEntry => {
        if (historyEntry.status == 0) {
            // add to total water usage if we have a valve closed event
            totalWater += parseFloat(historyEntry.water);
        }
    });

    var value = util.format(
        "00022300 0302 %s 040c4156323248314130303036330602080007042a3000000b0200000501000204f82c00001401030f0400000000450505000000004609050000000e000042064411051c0005033c0000003a814b42a34d8c4047110594186d19071ad91ab40000003c00000048060500000000004a06050000000000d004 %s 9b04 %s 2f0e %s 0000 2e02 %s 00000000000000001e02300c",
        //"00022300 0302 %s 45050500000000 4609050000000e0000 4806050000000000 4a06050000000000 d004 %s 9b04 %s 2f0e %s 0000 2e02 %s 00000000000000001e02300c",
        //"0302 %s 45050500000000 4609050000000e0000 4806050000000000 4a06050000000000 d004 %s 9b04 %s 2f0e %s 0000 2e02 %s",

        numberToEveHexString(1208, 4),  // firmware version (build 1208)
        numberToEveHexString(tempHistory.length != 0 ? tempHistory[tempHistory.length - 1].time : 0, 8),  // time of last event, 0 if never watered
        numberToEveHexString(Math.floor(new Date() / 1000), 8), // "now" time
        numberToEveHexString(Math.floor(totalWater * 1000), 16), // total water usage in ml (64bit value)
        numberToEveHexString(Math.floor(0 / 60), 4)); // water flow rate in ml/L
    return encodeEveData(value);
};

HomeKitHistory.prototype.__EveHistoryStatus = function(callback) {
    var tempHistory = this.getHistory(this.EveHome.type, this.EveHome.sub); // get flattened history array for easier processing
    var historyTime = (tempHistory.length == 0 ? Math.floor(new Date() / 1000) : tempHistory[tempHistory.length - 1].time);
    this.EveHome.reftime = (tempHistory.length == 0 ? (this.historyData.reset - EPOCH_OFFSET) : (tempHistory[0].time - EPOCH_OFFSET));
    this.EveHome.count = tempHistory.length;    // Number of history entries for this type

    var value = util.format(
        "%s 00000000 %s %s %s %s %s 000000000101",
        numberToEveHexString(historyTime - this.EveHome.reftime - EPOCH_OFFSET, 8),
        numberToEveHexString(this.EveHome.reftime, 8), // reference time (time of first history??)
        this.EveHome.signature1,
        numberToEveHexString(this.EveHome.count, 4), // count of entries
        numberToEveHexString(this.maxEntries == 0 ? MAX_HISTORY_SIZE : this.maxEntries, 4),  // history max size
        numberToEveHexString(1, 8));  // first entry

    callback(null, encodeEveData(value));
    //console.log("DEBUG: __EveHistoryStatus: history for '%s:%s' (%s) - Entries %s", this.EveHome.type, this.EveHome.sub, this.EveHome.evetype, this.EveHome.count);
}

HomeKitHistory.prototype.__EveHistoryEntries = function(callback) {
    // Streams our history data back to EveHome when requested
    var dataStream = "";
    if (this.EveHome.entry <= this.EveHome.count && this.EveHome.send != 0) {
        var tempHistory = this.getHistory(this.EveHome.type, this.EveHome.sub); // get flattened history array for easier processing

        dataStream += util.format(
            " 15 %s 0100 0000 81 %s 0000 0000 00 0000",
            numberToEveHexString(this.EveHome.entry, 8),
            numberToEveHexString(this.EveHome.reftime, 8)); // not sure this is actually needed

        for (var i = 0; i < EVEHOME_MAX_STREAM; i++) {
            if (tempHistory.length != 0 && (this.EveHome.entry - 1) <= tempHistory.length) {
                historyEntry = tempHistory[this.EveHome.entry - 1]; // need to map EveHome entry address to our data history, as EvenHome addreses start at 1
                switch (this.EveHome.evetype) {
                    case "aqua" : {
                        if (historyEntry.status == 1)  {
                            // Valve opened
                            dataStream += util.format(
                                " 0d %s %s %s %s 300c",
                                numberToEveHexString(this.EveHome.entry, 8),
                                numberToEveHexString(historyEntry.time - this.EveHome.reftime - EPOCH_OFFSET, 8),
                                this.EveHome.signature2,
                                numberToEveHexString(historyEntry.status, 2));
                        } else {
                            // Valve closed
                            dataStream += util.format(
                                " 15 %s %s %s %s %s 00000000 300c",
                                numberToEveHexString(this.EveHome.entry, 8),
                                numberToEveHexString(historyEntry.time - this.EveHome.reftime - EPOCH_OFFSET, 8),
                                this.EveHome.signature3,
                                numberToEveHexString(historyEntry.status, 2),
                                numberToEveHexString(Math.floor(parseFloat(historyEntry.water) * 1000), 8)); // in millilitres
                        }
                        break;
                    }

                    case "room": {
                        dataStream += util.format(
                            " 13 %s %s %s %s %s %s 0000 00",
                            numberToEveHexString(this.EveHome.entry, 8),
                            numberToEveHexString(historyEntry.time - this.EveHome.reftime - EPOCH_OFFSET, 8),
                            this.EveHome.signature2,
                            numberToEveHexString(historyEntry.temperature * 100, 4), // temperature
                            numberToEveHexString(historyEntry.humidity * 100, 4), // Humidity
                            numberToEveHexString(historyEntry.hasOwnProperty("ppm") ? historyEntry.ppm * 10 : 10, 4)); // PPM - air quality
                        break;
                    }

                    case "weather": {
                        dataStream += util.format(
                            " 10 %s %s %s %s %s %s",
                            numberToEveHexString(this.EveHome.entry, 8),
                            numberToEveHexString(historyEntry.time - this.EveHome.reftime - EPOCH_OFFSET, 8),
                            this.EveHome.signature2,
                            numberToEveHexString(historyEntry.temperature * 100, 4), // temperature
                            numberToEveHexString(historyEntry.humidity * 100, 4), // Humidity
                            numberToEveHexString(historyEntry.hasOwnProperty("pressure") ? historyEntry.pressure * 10 : 10, 4)); // Pressure
                        break;
                    }

                    case "motion" : 
                    case "contact" : 
                    case "switch " : {
                        // contact, motion and switch sensors treated the same for status
                        dataStream += util.format(
                            " 0b %s %s %s %s",
                            numberToEveHexString(this.EveHome.entry, 8),
                            numberToEveHexString(historyEntry.time - this.EveHome.reftime - EPOCH_OFFSET, 8),
                            this.EveHome.signature2,
                            numberToEveHexString(historyEntry.status, 2));
                        break;
                    }

                    case "door" : {
                        // Invert status for EveHome. As EveHome door is a contact sensor, where 1 is contact and 0 is no contact, opposite of what we expect a door to be
                        // ie: 0 = closed, 1 = opened
                        dataStream += util.format(
                            " 0b %s %s %s %s",
                            numberToEveHexString(this.EveHome.entry, 8),
                            numberToEveHexString(historyEntry.time - this.EveHome.reftime - EPOCH_OFFSET, 8),
                            this.EveHome.signature2,
                            numberToEveHexString(historyEntry.status == 1 ? 0 : 1, 2));  // status for EveHome (inverted ie: 1 = closed, 0 = opened) */
                        break;
                    }

                    case "thermo" : {
                        var tempTarget = 0;
                        if ((historyEntry.low && historyEntry.low == 0) && (historyEntry.high && historyEntry.high != 0)) tempTarget = historyEntry.target.high;   // heating limit
                        if ((historyEntry.low && historyEntry.low != 0) && (historyEntry.high && historyEntry.high != 0)) tempTarget = historyEntry.target.high;   // range, so using heating limit
                        if ((historyEntry.low && historyEntry.low != 0) && (historyEntry.high && historyEntry.high == 0)) tempTarget = 0;   // cooling limit
                        if ((historyEntry.low && historyEntry.low == 0) && (historyEntry.high && historyEntry.high == 0)) tempTarget = 0;   // off


                        dataStream += util.format(
                            " 11 %s %s %s %s %s %s 0000",
                            numberToEveHexString(this.EveHome.entry, 8),
                            numberToEveHexString(historyEntry.time - this.EveHome.reftime - EPOCH_OFFSET, 8),
                            this.EveHome.signature2,
                            numberToEveHexString(historyEntry.temperature * 100, 4), // temperature
                            numberToEveHexString(tempTarget * 100, 4), // target temperature for heating
                            numberToEveHexString(historyEntry.status == 2 ? 100 : 0, 2)); // 0% valve position = off, 100% = heating
                            //numberToEveHexString(historyEntry.status == 2 ? 100 : historyEntry.status == 1 ? 0 : 50, 2)); // 50% valve position = off, 0% = cooling, 100% = heating
                        break;
                    }

                    case "energy" : {
                        dataStream += util.format(
                            " 14 %s %s %s 0000 0000 %s 0000 0000",
                            numberToEveHexString(this.EveHome.entry, 8),
                            numberToEveHexString(historyEntry.time - this.EveHome.reftime - EPOCH_OFFSET, 8),
                            this.EveHome.signature2,
                            numberToEveHexString(historyEntry.watts * 10, 4));  // Power in watts
                        break;
                    }
                }
                this.EveHome.entry++;    
                if (this.EveHome.entry > this.EveHome.count) break;
            }
        }
        if (this.EveHome.entry > this.EveHome.count) {
            // No more history data to send back
            //console.log("DEBUG: __EveHistoryEntries: sent '%s' entries to EveHome ('%s') for '%s:%s'", this.EveHome.send, this.EveHome.evetype, this.EveHome.type, this.EveHome.sub);
            this.EveHome.send = 0;  // no more to send
            dataStream += " 00";
        }
    } else {
         // We're not transferring any data back
        //console.log("DEBUG: __EveHistoryEntries: do we ever get here.....???", this.EveHome.send, this.EveHome.evetype, this.EveHome.type, this.EveHome.sub, this.EveHome.entry);
        this.EveHome.send = 0;  // no more to send
        dataStream = "00";
    }
    callback(null, encodeEveData(dataStream));
}

HomeKitHistory.prototype.__EveHistoryRequest = function(value, callback) {
    // Requesting history, starting at specific entry
    this.EveHome.entry = EveHexStringToNumber(decodeEveData(value).substring(4, 12));    // Starting entry
    if (this.EveHome.entry == 0) {
        this.EveHome.entry = 1; // requested to restart from beginning of history for sending to EveHome
    }
    this.EveHome.send = (this.EveHome.count - this.EveHome.entry + 1);    // Number of entries we're expected to send
    callback();
    //console.log("DEBUG: __EveHistoryRequest: requested address", this.EveHome.entry);
}

HomeKitHistory.prototype.__EveSetTime = function(value, callback) {
    // Time stamp from EveHome
    var timestamp = (EPOCH_OFFSET + EveHexStringToNumber(decodeEveData(value)));
    callback();
    //console.log("DEBUG: __EveSetTime: timestamp offset", new Date(timeStamp * 1000));
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

Characteristic.EveGetConfiguration = function () {
	Characteristic.call(this, "Eve Get Configuration", "E863F131-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: Characteristic.Formats.DATA,
        perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
	});
	this.value = this.getDefaultValue();
}
util.inherits(Characteristic.EveGetConfiguration, Characteristic);
Characteristic.EveGetConfiguration.UUID = "E863F131-079E-48FF-8F27-9C2605A29F52";

Characteristic.EveSetConfiguration = function () {
	Characteristic.call(this, "Eve Set Confoguration", "E863F11D-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: Characteristic.Formats.DATA,
        perms: [Characteristic.Perms.WRITE, Characteristic.Perms.HIDDEN]
	});
	this.value = this.getDefaultValue();
}
util.inherits(Characteristic.EveSetConfiguration, Characteristic);
Characteristic.EveSetConfiguration.UUID = "E863F11D-079E-48FF-8F27-9C2605A29F52";

Characteristic.EveFirmwareInfo = function () {
	Characteristic.call(this, "Eve Motion Sensitivity", "E863F12C-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: Characteristic.Formats.DATA,
        perms: [Characteristic.Perms.READ, Characteristic.Perms.WRITE, Characteristic.Perms.NOTIFY]
	});
	this.value = this.getDefaultValue();
}
util.inherits(Characteristic.EveFirmwareInfo, Characteristic);
Characteristic.EveFirmwareInfo.UUID = "E863F12C-079E-48FF-8F27-9C2605A29F52";

Characteristic.EveSensitivity = function () {
	Characteristic.call(this, "Eve Motion Sensitivity", "E863F120-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: Characteristic.Formats.UINT8,
        perms: [Characteristic.Perms.READ, Characteristic.Perms.WRITE, Characteristic.Perms.NOTIFY],
        minValue: 0,
        maxValue: 7,
        validValues: [0, 4, 7]
	});
	this.value = this.getDefaultValue();
}
util.inherits(Characteristic.EveSensitivity, Characteristic);
Characteristic.EveSensitivity.UUID = "E863F120-079E-48FF-8F27-9C2605A29F52";

Characteristic.EveDuration = function () {
	Characteristic.call(this, "Eve Motion Duration", "E863F12D-079E-48FF-8F27-9C2605A29F52");
	this.setProps({
        format: Characteristic.Formats.UINT16,
        perms: [Characteristic.Perms.READ, Characteristic.Perms.WRITE, Characteristic.Perms.NOTIFY],
        minValue: 5,
        maxValue: 54000,
        validValues: [5, 10, 20, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200, 10800, 18000, 36000, 43200, 54000]
	});
	this.value = this.getDefaultValue();
}
util.inherits(Characteristic.EveDuration, Characteristic);
Characteristic.EveDuration.UUID = "E863F12D-079E-48FF-8F27-9C2605A29F52";

// "E863F122-079E-48FF-8F27-9C2605A29F52" - humidity
// "E863F108-079E-48FF-8F27-9C2605A29F52" - temperature

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