// HAP-Nodejs Garage Door opener accessory
// Mark Hulskamp
//
// https://shop.pimoroni.com/products/automation-phat
// https://www.miniwebtool.com/mac-address-generator/ (Created mac address mirroring merlin/chamberlan range)
//
// GPIO Pin Assignments for pHAT board
// ------------------------------------
// GPIO26	Input 1
// GPIO20	Input 2
// GPIO21	Input 3
// GPIO5	Output 1
// GPIO12	Output 2
// GPIO6	Output 3
// GPIO16	Relay 1
//
// todo
// -- Get obstruction code working and verifed
// -- Turn into accessory factory in HAP-NodeJS, so each garage door created has its own accessory
//
// done
// -- Set accessory type icon for pairing. Requires change to HAP-NodeJS Core.js until present in main code
// -- Use MAC address in the range mirroring merlin/chamberlan devices
// -- updated to use npm version of hap-nodejs directory structure (11/4/2020) 
//
// bugs
// -- Bug if manually opened door and stopped between open/close then press close/open in HomeKit.. confused logic. Not sure be worked around


var JSONPackage = require("../../package.json");
var Accessory = require("../").Accessory; 
var Service = require("../").Service;
var Characteristic = require("../").Characteristic;
var uuid = require("../").uuid;
var GPIO = require("rpio");
var HomeKitHistory = require("./HomeKitHistory");

// Defines for the accessory
const AccessoryName =  "Garage Door";                   // name of accessory
const AccessoryPincode = "031-45-154";                  // pin code for pairing 
const AccessoryUsername = "xx:xx:xx:xx:xx:xx";          // MAC like address used by HomeKit to differentiate accessories. 
const AccessoryManufacturer = "Some Manufacturer";      // manufacturer
const AccessoryModel = "Some Model";                    // model
const AccessorySerialNumber = "MH20200520";             // serial number
const AccessoryFirmwareRevision = JSONPackage.version;  // firmware revision

// Create the "garage door" object. This can be used as the template for multiple doors under
// the one accessory ie: left and right doors
function GarageDoorClass() {
    this.__DoorService = null;			// HomeKit service for this door
    this.__cachedDoorState = null;      // Cached state of the door. used to update HomeKit. Initally no value
    this.__movingTimer = null;          // object to created timer for door moving
    this.GPIO_PushButton = 0;           // GPIO Pin Garage open/close button
    this.GPIO_ClosedSensor = 0;         // GPIO pin for closed sensor
    this.GPIO_OpenedSensor = 0;         // GPIO pin for opened sensor
    this.GPIO_ObstructionSensor = 0;    // GPIO pin for obstruction sensor (0 disabled)
    this.OpenTimeMS = 0;	    	    // Time for door to fully open in MS
    this.CloseTimeMS = 0;		        // Time for door to fully close in MS
    this.historyService = null;         // History logging service
}


GarageDoorClass.prototype.addGarageDoor = function(HomeKitAccessory, thisServiceName, serviceNumber) {
    // Add this door to the "master" accessory and set properties
    this.__DoorService = HomeKitAccessory.addService(Service.GarageDoorOpener, thisServiceName, serviceNumber);
    this.__DoorService.addCharacteristic(Characteristic.StatusFault); // Used if the sensors report incorrect readings, such as both "high"
    this.__DoorService.removeCharacteristic(Characteristic.ObstructionDetected);    // Remove the obstruction characteristic.. We'll add later if setup

    // Initialise the GPIO input/output PINs for this door
    GPIO.init({gpiomem: true});
    GPIO.init({mapping: 'gpio'});
    if (this.GPIO_PushButton != 0) GPIO.open(this.GPIO_PushButton, GPIO.OUTPUT, GPIO.LOW);
    if (this.GPIO_ClosedSensor != 0) GPIO.open(this.GPIO_ClosedSensor, GPIO.INPUT); 
    if (this.GPIO_OpenedSensor != 0) GPIO.open(this.GPIO_OpenedSensor, GPIO.INPUT);

    // Setup HomeKit callbacks
    this.__DoorService.getCharacteristic(Characteristic.CurrentDoorState).on('get', this.getGarageDoorState.bind(this));
    this.__DoorService.getCharacteristic(Characteristic.TargetDoorState).on('set', this.setGarageDoorState.bind(this));

    // Setup logging
    this.historyService = new HomeKitHistory(HomeKitAccessory, {});
    this.historyService.linkToEveHome(HomeKitAccessory, this.__DoorService);

    // Perform inital update of door status for HomeKit
    this.__updateHomeKit(HomeKitAccessory, false, 500);

    console.log("Setup GarageDoor '%s' on '%s'", thisServiceName, HomeKitAccessory.username);
}
    
GarageDoorClass.prototype.addObstructionSensor = function(HomeKitAccessory, obstructionSensorPin) {
    if (obstructionSensorPin != 0) {
        this.GPIO_ObstructionSensor = obstructionSensorPin;
        GPIO.open(this.GPIO_ObstructionSensor, GPIO.INPUT);
        
        this.__DoorService.addCharacteristic(Characteristic.ObstructionDetected);
     
        console.log("Obstruction detection enabled for '%s' using GPIO pin '%s'", this.__DoorService.getCharacteristic(Characteristic.Name).value, obstructionSensorPin);
    }
}

GarageDoorClass.prototype.getGarageDoorState = function(callback) {      
    // Return position of the door by use of sensors, otherwise, the current status assumed by HomeKit
    this.__updateHomeKit(null, false, 0);
    callback(null, this.__cachedDoorState);
}
	
GarageDoorClass.prototype.setGarageDoorState = function(state, callback) {      
    // Set position of the door. (will either be open or closed)
    if ((state == Characteristic.TargetDoorState.CLOSED) && (GPIO.read(this.GPIO_ClosedSensor) == GPIO.LOW)) {
        if (this.__DoorService.getCharacteristic(Characteristic.CurrentDoorState).value == Characteristic.CurrentDoorState.OPENING) {
            // Since door is "moving", press button to stop. Second press below will close ie: reverse
            clearTimeout(this.__movingTimer);
            this.__movingTimer = null;
            this.pressButton(this.GPIO_PushButton, 500);
            this.__DoorService.getCharacteristic(Characteristic.CurrentDoorState).updateValue(Characteristic.CurrentDoorState.STOPPED);
            this.__DoorService.getCharacteristic(Characteristic.TargetDoorState).updateValue(Characteristic.CurrentDoorState.CLOSED);
        }
        // "Press" garage opener/closer button, and update HomeKit status to show door moving. 
        // the poll funtion will update to the closed status when sensor triggered
        this.pressButton(this.GPIO_PushButton, 500);
        this.__DoorService.getCharacteristic(Characteristic.CurrentDoorState).updateValue(Characteristic.CurrentDoorState.CLOSING);
    } else if ((state == Characteristic.TargetDoorState.OPEN) && (GPIO.read(this.GPIO_OpenedSensor) == GPIO.LOW)) {
        if (this.__DoorService.getCharacteristic(Characteristic.CurrentDoorState).value  == Characteristic.CurrentDoorState.CLOSING) {
            // Since door is "moving", press button to stop. Second press below will close ie: reverse
            clearTimeout(this.__movingTimer);   
            this.__movingTimer = null;
            this.pressButton(this.GPIO_PushButton, 500);
            this.__DoorService.getCharacteristic(Characteristic.CurrentDoorState).updateValue(Characteristic.CurrentDoorState.STOPPED);
            this.__DoorService.getCharacteristic(Characteristic.TargetDoorState).updateValue(Characteristic.CurrentDoorState.OPEN);
        }
        // "Press" garage opener/closer button, and update HomeKit status to show door moving. 
        // the poll funtion will update to the open status when sensor triggered
        this.pressButton(this.GPIO_PushButton, 500);
        this.__DoorService.getCharacteristic(Characteristic.CurrentDoorState).updateValue(Characteristic.CurrentDoorState.OPENING);
    }
    callback();
}

GarageDoorClass.prototype.refreshHomeKit = function(HomeKitAccessory, refreshTimeMS) {
    // setup status check interval as defined
    this.__refreshTimer = setInterval(this.__updateHomeKit.bind(this, HomeKitAccessory, true, refreshTimeMS), refreshTimeMS); 
    console.log("HomeKit refresh for '%s' set for every '%s'ms", AccessoryName, refreshTimeMS);
}
    
GarageDoorClass.prototype.__updateHomeKit = function(HomeKitAccessory, triggerTimeout, refreshTimeMS) {
    // Determines status of the door by the sensors present and updates HomeKit to reflect this
    var currentOpenSensor = GPIO.read(this.GPIO_OpenedSensor);
    var currentCloseSensor = GPIO.read(this.GPIO_ClosedSensor);
    
    this.__DoorService.getCharacteristic(Characteristic.StatusFault).updateValue(Characteristic.StatusFault.NO_FAULT);

    if (currentCloseSensor == GPIO.HIGH && currentOpenSensor == GPIO.LOW) {
        if (this.__cachedDoorState != Characteristic.CurrentDoorState.CLOSED) {
            // Clear moving door timeout for door closing
            clearTimeout(this.__movingTimer);
            this.__movingTimer = null;
            
            // determined the door is actually closed, so update the internal door status to this.
            // Update HomeKit also to reflect this
            this.__DoorService.getCharacteristic(Characteristic.CurrentDoorState).updateValue(Characteristic.CurrentDoorState.CLOSED);
            this.__DoorService.getCharacteristic(Characteristic.TargetDoorState).updateValue(Characteristic.CurrentDoorState.CLOSED);

            if (this.historyService != null) {
                var historyEntry = this.historyService.lastHistory(this.__DoorService);
                if (historyEntry == null || (typeof historyEntry == "object" && historyEntry.status != 0)) {
                    // only log entry if last recorded entry is different
                    // helps with restarts
                    this.historyService.addHistory(this.__DoorService, {time: Math.floor(new Date() / 1000), status: 0}); // closed
                }
            }

            this.__cachedDoorState = Characteristic.CurrentDoorState.CLOSED;
        }
    } else if (currentOpenSensor == GPIO.HIGH && currentCloseSensor == GPIO.LOW) {
        if (this.__cachedDoorState != Characteristic.CurrentDoorState.OPEN) {
            // Clear moving door timer for door opening
            clearTimeout(this.__movingTimer);
            this.__movingTimer = null;

            // determined the door is actually opened, so update the internal door status to this
            this.__DoorService.getCharacteristic(Characteristic.CurrentDoorState).updateValue(Characteristic.CurrentDoorState.OPEN);
            this.__DoorService.getCharacteristic(Characteristic.TargetDoorState).updateValue(Characteristic.CurrentDoorState.OPEN);

            if (this.historyService != null) {
                var historyEntry = this.historyService.lastHistory(this.__DoorService);
                if (historyEntry == null || (typeof historyEntry == "object" && historyEntry.status != 1)) {
                    // only log entry if last recorded entry is different
                    // helps with restarts
                    this.historyService.addHistory(this.__DoorService, {time: Math.floor(new Date() / 1000), status: 1}); // opened
                }
            }

            this.__cachedDoorState = Characteristic.CurrentDoorState.OPEN;
        }
    } else if (currentCloseSensor == GPIO.LOW && currentOpenSensor == GPIO.LOW) {
        // door is neither open or closed, so now need to determine if we are transitioning from open -> closed, closed -> opened or stopped
        // stopped state will be determined by timeout ie: full door open/close time
        if (this.__cachedDoorState == Characteristic.CurrentDoorState.CLOSED) {
            // Clear moving door timeout
            clearTimeout(this.__movingTimer);
            this.__movingTimer = null;

            // since last status was closed, we'll assume transitioning to open
            // Update HomeKit also to reflect this
            this.__cachedDoorState = Characteristic.CurrentDoorState.OPENING;
            this.__DoorService.getCharacteristic(Characteristic.CurrentDoorState).updateValue(Characteristic.CurrentDoorState.OPENING);
            this.__DoorService.getCharacteristic(Characteristic.TargetDoorState).updateValue(Characteristic.CurrentDoorState.OPEN);

            // Start moving door timer for opening
            this.__movingTimer = setTimeout(this.__movingTimeout.bind(this), this.OpenTimeMS);
        } else if (this.__cachedDoorState == Characteristic.CurrentDoorState.OPEN) {
            // Clear moving door timeout
            clearTimeout(this.__movingTimer);
            this.__movingTimer = null;

            // since last status was open, we'll assume transitioning to closed
            // Update HomeKit also to reflect this
            this.__cachedDoorState = Characteristic.CurrentDoorState.CLOSING;
            this.__DoorService.getCharacteristic(Characteristic.CurrentDoorState).updateValue(Characteristic.CurrentDoorState.CLOSING);
            this.__DoorService.getCharacteristic(Characteristic.TargetDoorState).updateValue(Characteristic.CurrentDoorState.CLOSED);

            // Start moving door timer for closing
            this.__movingTimer = setTimeout(this.__movingTimeout.bind(this), this.CloseTimeMS);
        }
    } else if (currentCloseSensor == GPIO.HIGH && currentOpenSensor == GPIO.HIGH) {
        // Sensors reading door is opened and closed. Would indicate a fault?
        this.__DoorService.getCharacteristic(Characteristic.StatusFault).updateValue(Characteristic.StatusFault.GENERAL_FAULT);
    }
}

GarageDoorClass.prototype.__movingTimeout = function () {
    // Used for timeout of door open/close to work out if the door was stopped while opening or closing
    // should get triggered when opening or closing time exceeds the defined limits. If this happens, we assume
    // door has stopped. Set status of this. Will need to set "target door" state as the door reverses direction on stopped
    if (this.__DoorService.getCharacteristic(Characteristic.CurrentDoorState).value == Characteristic.CurrentDoorState.OPENING) {
        // Door was opening
        this.__DoorService.getCharacteristic(Characteristic.TargetDoorState).updateValue(Characteristic.CurrentDoorState.OPEN);
    } else if (this.__DoorService.getCharacteristic(Characteristic.CurrentDoorState).value == Characteristic.CurrentDoorState.CLOSING) {
        // Door was closing
        this.__DoorService.getCharacteristic(Characteristic.TargetDoorState).updateValue(Characteristic.CurrentDoorState.CLOSED);
    }
    this.__DoorService.getCharacteristic(Characteristic.CurrentDoorState).updateValue(Characteristic.CurrentDoorState.STOPPED);
    this.__cachedDoorState = Characteristic.CurrentDoorState.STOPPED;
}

GarageDoorClass.prototype.pressButton = function(GPIO_Pin, holdforMS) {
    // Simulate pressing the controller button
    // Write high out first to trigger relay, then wait defined millisecond period and put back to low to untrigger	
    GPIO.write(GPIO_Pin, GPIO.HIGH);
    GPIO.msleep(holdforMS);
    GPIO.write(GPIO_Pin, GPIO.LOW);
}


// Create the garage door opener accessory
var garageAccessory = exports.accessory = new Accessory(AccessoryName, uuid.generate("hap-nodejs:accessories:garage_" + AccessoryName));
garageAccessory.username = AccessoryUsername; 
garageAccessory.pincode = AccessoryPincode;
garageAccessory.category = Accessory.Categories.GARAGE_DOOR_OPENER;	// Garge door type accessory
garageAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Manufacturer, AccessoryManufacturer);
garageAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Model, AccessoryModel);
garageAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.SerialNumber, AccessorySerialNumber);
garageAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, AccessoryFirmwareRevision);

// Create the garage for the HomeKit garage door opener accessory
var GarageDoor = new GarageDoorClass();
GarageDoor.GPIO_PushButton = 16;	// pHAT relay 1
GarageDoor.GPIO_ClosedSensor = 26;	// pHAT Input 1
GarageDoor.GPIO_OpenedSensor = 20;	// pHAT Input 2
GarageDoor.CloseTimeMS = 25000;	// Max closing time of door in ms.. Slightly longer than actual time
GarageDoor.OpenTimeMS = 25000;	// Max opening time of door in ms.. Slightly longer than actual time
GarageDoor.addGarageDoor(garageAccessory, "Garage Door", 1);
//GarageDoor.addObstructionSensor(garageAccessory, 21); // pHAT Input 3
GarageDoor.refreshHomeKit(garageAccessory, 500); // refresh HomeKit status every 500ms
