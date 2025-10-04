import re, sys, serial, time
import matplotlib.pyplot as plt
from collections import deque

PORT = sys.argv[1] if len(sys.argv)>1 else 'COM5'  # замените на ваш порт ESP32
BAUD = 115200
pat = re.compile(r"elev=(?P<elev>-?\d+),grip=(?P<grip>-?\d+),L=(?P<L>\d+),R=(?P<R>\d+),thr=(?P<thr>\d+)")

ser = serial.Serial(PORT, BAUD, timeout=0.1)
win = 400
buf = {k: deque(maxlen=win) for k in ('elev','grip','L','R','thr')}

plt.ion()
fig, ax = plt.subplots()
lns = {k: ax.plot([], [], label=k)[0] for k in buf}
ax.set_title('RBM Telemetry'); ax.legend(); ax.grid(True)

def update_plot():
    for k, ln in lns.items():
        ln.set_data(range(len(buf[k])), list(buf[k]))
    ax.relim(); ax.autoscale_view()
    plt.pause(0.001)

try:
    while True:
        line = ser.readline().decode(errors='ignore').strip()
        m = pat.search(line)
        if m:
            for k,v in m.groupdict().items(): buf[k].append(float(v))
            update_plot()
except KeyboardInterrupt:
    pass
finally:
    ser.close()