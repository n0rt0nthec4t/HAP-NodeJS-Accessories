# import python libraries 
import sys
import time
import RPi.GPIO as GPIO

GPIO_TRIGGER = int(sys.argv[1])     # GPIO pin for trigger
GPIO_ECHO = int(sys.argv[2])        # GPIO pin for echo
speedSound = 34300                  # Speed of sound in cm/s at temperature

# Setup GPIO and pins as output and input
GPIO.setwarnings(False)
GPIO.setmode(GPIO.BCM)              # Use BCM GPIO references instead of physical pin numbers
GPIO.setup(GPIO_TRIGGER,GPIO.OUT)   # Trigger
GPIO.setup(GPIO_ECHO,GPIO.IN)       # Echo

def measure():
    #taking measurment
    GPIO.output(GPIO_TRIGGER, False)    # Set trigger to False (Low)
    time.sleep(0.5)                     # Allow module to settle
    GPIO.output(GPIO_TRIGGER, True)     # Send 10us pulse to trigger
    time.sleep(0.00001)                 # Wait 10us
    GPIO.output(GPIO_TRIGGER, False)
    start = time.time()
    while GPIO.input(GPIO_ECHO)==0:
        start = time.time()
    while GPIO.input(GPIO_ECHO)==1:
        stop = time.time()

    # Calculate distance
    elapsed = stop-start
    distance = round((elapsed * speedSound) / 2, 2)

    return distance

print(measure())
GPIO.cleanup()

