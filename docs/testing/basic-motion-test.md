# Basic Motion Smoke Test

## Purpose

This checklist validates the drivetrain, turning, lift and gripper subsystems on the RBM robot after firmware deployment. Each exercise is short and repeatable, intended for benchtop verification before rolling on the field.

## Prerequisites

- Robot is on a stand so wheels and lift can move freely.
- MPS/E-STOP is open (no motor power) until instructed; power rails and USB are connected.
- ESP32 and UNO are flashed with the current firmware revision.
- Operator stack (`./scripts/operator_stack.sh start` or Docker equivalent) is running; CLI is available as `rbm-operator` from `backend/operator/.venv`.
- A second person is present when applying motor power.

## Bring-Up Sequence

1. Open motor power (MPS) only when the checklist explicitly calls for it.
2. In a terminal, activate the Python virtualenv and export `OPERATOR_CONTROL_TRANSPORT` if needed.
3. Verify connectivity:

   ```bash
   rbm-operator command STATUS
   ```

   Expect `err_flags=0x0000`, `mps=0`, `estop=1`, and `wifi_connected=true/false` depending on transport.
4. Home lift and gripper (UNO must be online):

   ```bash
   rbm-operator command "CTRL HOME"
   ```

   Wait for telemetries `elev_mm≈0`, `grip_deg≈cfg_grip.deg_min` in the subsequent `STATUS` reply.

## Motion Exercises

> Between motion blocks close the brake to neutralise actuators:
>
> ```bash
> rbm-operator brake
> ```

### 1. Straight Drive (Forward / Reverse)

1. Close MPS (apply motor power) while the robot remains on the stand.
2. Forward:

   ```bash
   rbm-operator command "CTRL DRIVE vx=200 t=1500"
   ```

   - Expect both wheels to spin forward smoothly.
   - `STATUS` should report `drive_left`/`drive_right` around 1700–1800 µs and odometry counts increasing.
3. Reverse:

   ```bash
   rbm-operator command "CTRL DRIVE vx=-200 t=1500"
   ```

   - Wheels spin backward; odometry decreases symmetrically.
4. Issue `rbm-operator brake` after each run.

### 2. In-Place Turns (Left / Right)

1. Left pivot:

   ```bash
   rbm-operator command "CTRL TURN dir=left speed=350 t=1200"
   ```

   - Wheels counter-rotate; observe odometry (`odo_left` increasing, `odo_right` decreasing).
2. Right pivot:

   ```bash
   rbm-operator command "CTRL TURN dir=right speed=350 t=1200"
   ```

   - Odometry signs swap.
3. Brake after each turn.

### 3. Lift Travel

1. Raise to transport height:

   ```bash
   rbm-operator command "CTRL ELEV h=120 speed=120"
   ```

   - Confirm lift encoder count grows; `elev_mm` approaches 120 ±2 mm.
2. Lower to home:

   ```bash
   rbm-operator command "CTRL ELEV h=0 speed=120"
   ```

   - Encoder returns to zero; mechanical end-stop not hit (watch `err_flags`).

### 4. Gripper Actuation

1. Close fully:

   ```bash
   rbm-operator command "CTRL GRIP CLOSE"
   ```

   - `grip_deg` moves towards `cfg_grip.deg_max`; servo current rises briefly.
2. Open fully:

   ```bash
   rbm-operator command "CTRL GRIP OPEN"
   ```

   - `grip_deg` returns to minimum; verify jaws release freely.
3. Optional mid-angle hold (e.g. 45°):

   ```bash
   rbm-operator command "CTRL GRIP deg=45"
   ```

   - Expect stable position without chatter.

### 5. Recovery

1. Neutralise actuators:

   ```bash
   rbm-operator brake
   ```

2. Open MPS.
3. Record final status snapshot for the log:

   ```bash
   rbm-operator command STATUS
   ```

   Archive the output alongside operator logs as evidence.

## Observability Tips

- Run `rbm-operator telemetry --command status --interval 0.5` in a separate terminal to watch live telemetry during motions.
- `drive_left/right` should remain within 1100–1900 µs. Values hitting limits indicate calibration or mechanical issues.
- `err_flags` bits `LIFT_LIMIT`, `LIFT_ENC`, `GRIP_ENC` must stay clear; any fault aborts the sequence until resolved.

## Report Template

| Field            | Notes                                              |
| ---------------- | -------------------------------------------------- |
| Date / Time      | ISO timestamp of the run                           |
| Operator        | Who executed the checklist                         |
| Firmware Build  | Git commit / tag for ESP32 + UNO                    |
| Transport       | UART / Wi-Fi, include active endpoint if Wi-Fi      |
| Observations    | Bullet list of anomalies or confirmations           |
| Attached Logs   | Paths to STATUS snapshots, operator logs, photos    |

> Attach the final `STATUS` output and any oscilloscope/current traces used during validation.

## Troubleshooting

- **UNO offline / ctrl_error=UNO_OFFLINE**: check I²C harness and reopen MPS; rerun `CTRL HOME`.
- **ctrl_error=I2C**: lost communication during command; inspect logs (`./scripts/operator_stack.sh logs backend`) for `[I2C]` errors.
- **Lift stalls**: reduce `speed` parameter (e.g. 80) and inspect mechanics before retrying.
- **Gripper buzzes**: ensure no obstruction; verify `cfg_grip` and recalibrate encoder zero.
