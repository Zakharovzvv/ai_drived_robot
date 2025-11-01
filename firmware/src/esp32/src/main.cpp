#ifdef MINIMAL_FIRMWARE
#include <Arduino.h>
#include <Wire.h>
#include "config.hpp"

namespace {
void scan_bus(){
  Serial.println("Scanning...");
  uint8_t found = 0;
  for(uint8_t addr = 1; addr < 0x7F; ++addr){
    Wire.beginTransmission(addr);
    uint8_t err = Wire.endTransmission();
    if(err == 0){
      Serial.print("I2C device found at address 0x");
      if(addr < 16) Serial.print("0");
      Serial.println(addr, HEX);
      ++found;
    }else if(err == 4){
      Serial.print("Unknown error at address 0x");
      if(addr < 16) Serial.print("0");
      Serial.println(addr, HEX);
    }
    delay(2);
  }
  if(!found){
    Serial.println("No I2C devices found");
  }
  Serial.println("done");
  Serial.flush();
}
}  // namespace

void setup(){
  delay(1000);
  Serial.begin(9600);
  delay(1000);
  Serial.println("=== ESP32 MINIMAL I2C MODE ===");
  Wire.begin(I2C_SDA, I2C_SCL);
  Serial.print("Pins: SDA=");
  Serial.print(I2C_SDA);
  Serial.print(" SCL=");
  Serial.println(I2C_SCL);
  Serial.flush();
}

void loop(){
  scan_bus();
  delay(5000);
}
#else
#include <Arduino.h>
#include <cstring>
#include <ctype.h>
#include "camera_http.hpp"
#include "cli_handler.hpp"
#include "cli_ws.hpp"
#include "config.hpp"
#include "log_sink.hpp"
#include "i2c_link.hpp"
#include "shelf_map.hpp"
#include "vision_color.hpp"
#include "wifi_link.hpp"
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

enum BTState { ST_INIT, ST_PICK, ST_GOPLACE, ST_PLACE };
BTState st = ST_INIT;
ColorID current_pick = C_NONE;
uint32_t t_state_ms = 0;
static bool g_uno_ready = false;

static void process_cli(Stream& io);
static void cli_execute_unlocked(const String& command, Stream& io);
static void cli_print_status(Stream& io);
static void cli_print_camcfg(Stream& io);
static uint32_t g_last_uno_check_ms = 0;
static SemaphoreHandle_t g_cli_mutex = nullptr;

struct I2CScanResult {
  uint8_t found = 0;
  uint8_t errors = 0;
  bool uno_found = false;
};

static I2CScanResult i2c_scan_bus(Stream* io);

namespace {

struct CtrlToken {
  String key;
  String value;
};

static bool parse_int(const String& text, long& out){
  if(!text.length()) return false;
  for(size_t i = 0; i < text.length(); ++i){
    char c = text[i];
    if(i == 0 && (c == '-' || c == '+')) continue;
    if(!isDigit(static_cast<unsigned char>(c))) return false;
  }
  out = text.toInt();
  return true;
}

static int16_t to_i16(long value){
  if(value < -32768L) return static_cast<int16_t>(-32768L);
  if(value > 32767L) return static_cast<int16_t>(32767L);
  return static_cast<int16_t>(value);
}

static size_t parse_tokens(const String& payload, CtrlToken* out, size_t maxTokens){
  String normalized = payload;
  normalized.replace(',', ' ');
  size_t count = 0;
  int start = 0;
  while(start < normalized.length() && count < maxTokens){
    int end = normalized.indexOf(' ', start);
    if(end < 0) end = normalized.length();
    String token = normalized.substring(start, end);
    token.trim();
    if(token.length()){
      int eq = token.indexOf('=');
      if(eq >= 0){
        out[count].key = token.substring(0, eq);
        out[count].value = token.substring(eq + 1);
      }else{
        out[count].key = token;
        out[count].value = "";
      }
      out[count].key.trim();
      out[count].value.trim();
      out[count].key.toUpperCase();
      ++count;
    }
    start = end + 1;
  }
  return count;
}

}  // namespace

void setup(){
  delay(1000);  // Задержка перед Serial
  Serial.begin(9600);
  delay(1000);  // Задержка после Serial
  Serial.println("[DBG] setup entry");
  Serial.flush();
  log_sink_init();
  Serial.println("[DBG] log_sink ready");
  Serial.flush();
  log_line("[ESP32] Boot");
  g_cli_mutex = xSemaphoreCreateMutex();
  if(!g_cli_mutex){
    log_line("[CLI] mutex allocation failed");
  }
  wifi_init();
  cli_ws_init();
  camera_http_init();
  // I2C
  bool i2c_ok = i2c_init();
  if(!i2c_ok){
    log_line("[ESP32] I2C init failed; UNO link disabled");
    g_uno_ready = false;
  }else{
    I2CScanResult scan = i2c_scan_bus(nullptr);
    if(scan.uno_found){
      g_uno_ready = i2c_ping_uno();
    }else{
      g_uno_ready = false;
    }
    if(!g_uno_ready){
      log_line("[ESP32] UNO not responding; automation disabled");
    }
    g_last_uno_check_ms = millis();
  }
  // Camera
  if(!cam_init()) log_line("[ESP32] Camera init FAILED");
  framesize_t detectedMax = camera_http_detect_supported_max_resolution();
  logf("[ESP32] Camera max resolution detected: %s",
    camera_http_resolution_name(detectedMax));
  camera_http_sync_sensor();
  // Shelf map
  if(!gShelf.loadNVS()){ gShelf.setDefault(); gShelf.saveNVS(); }
  logf("[ESP32] SHELF_MAP: %s", gShelf.toString().c_str());
  // Example configs
  if(g_uno_ready){
    i2c_cfg_line(0); // auto
    i2c_cfg_odo(192, 16, 1, 160, 600); // cpr/gear/wheel/track -- adjust!
    i2c_seq();
  }
  t_state_ms = millis();
}

static bool go_brake(){
  if(!g_uno_ready) return false;
  return i2c_cmd_brake();
}

static void drive_ms(int16_t vx,int16_t vy,int16_t w,int16_t t){
  if(!g_uno_ready) return;
  i2c_cmd_drive(vx,vy,w,t);
  delay(t);
}

void loop(){
  cli_ws_tick();
  wifi_tick();
  int loopAvail = Serial.available();
  if(loopAvail){
    logf("[LOOP] available=%d", loopAvail);
  }
  process_cli(Serial);

  if(!g_uno_ready && millis() - g_last_uno_check_ms > 2000){
    g_uno_ready = i2c_ping_uno();
    g_last_uno_check_ms = millis();
    if(g_uno_ready){
        log_line("[ESP32] UNO link restored");
    }
  }

  // Simple BT
  if(g_uno_ready){
    switch(st){
    case ST_INIT:{
      // Homing subsystems
      if(!i2c_cmd_home()){
          log_line("[BT] UNO busy during HOME; disabling automation");
        g_uno_ready = false;
        g_last_uno_check_ms = millis();
        break;
      }
      delay(600);
      st = ST_PICK; t_state_ms = millis();
    } break;
    case ST_PICK:{
      // Go to conveyor (placeholder: straight for 500ms)
      if(!i2c_cmd_drive(200,0,0,500)){
          log_line("[BT] DRIVE failed; disabling automation");
        g_uno_ready = false;
        g_last_uno_check_ms = millis();
        break;
      }
      // Detect color
      current_pick = detect_cylinder_color();
        logf("[BT] Detected color: %d", static_cast<int>(current_pick));
      // Close grip and lift to carry height (example 120mm)
      i2c_cmd_grip(1 /*CLOSE*/, 0);
      i2c_cmd_elev(120, 100, 0);
      delay(300);
      st = ST_GOPLACE; t_state_ms = millis();
    } break;
    case ST_GOPLACE:{
      // In a real run we would pathfind by A* and line-follow; here we simulate forward drive
      if(!i2c_cmd_drive(200,0,0,800)){
          log_line("[BT] DRIVE (place) failed; disabling automation");
        g_uno_ready = false;
        g_last_uno_check_ms = millis();
        break;
      }
      st = ST_PLACE; t_state_ms = millis();
    } break;
    case ST_PLACE:{
      // Elevate based on shelf row (example mapping)
      int row=0,col=0;
      // Find first occurrence of color
      bool found=false;
      for(int r=0;r<3 && !found;r++)
        for(int c=0;c<3 && !found;c++)
          if(gShelf.map[r][c]==current_pick){ row=r; col=c; found=true; }
      int targetH = row==0? 100 : (row==1? 180 : 260); // example heights
      i2c_cmd_elev(targetH, 120, 0);
      delay(300);
      // Open
      i2c_cmd_grip(0 /*OPEN*/, 0);
      delay(150);
      go_brake();
      st = ST_PICK; t_state_ms = millis();
    } break;
  }
  }

  // Telemetry print minimal
  static uint32_t tPrint=0;
  if(millis()-tPrint>500){
    if(g_uno_ready){
      Status0 s0; Odom od; Lines ln;
      if(read_STATUS0(s0) && read_ODOM(od) && read_LINES(ln)){
          logf("[TLM] st=%u err=0x%04X ODO(L=%ld R=%ld) L=%u R=%u",
            s0.state_id,
            s0.err_flags,
            static_cast<long>(od.L),
            static_cast<long>(od.R),
            ln.L,
            ln.R
          );
      }
    }else{
        log_line("[TLM] UNO offline");
    }
    tPrint = millis();
  }
}

static void process_cli(Stream& io){
  int available = io.available();
  if(!available) return;
  logf("[CLI] available=%d", available);
  String cmd = io.readStringUntil('\n');
  cmd.trim();
  if(!cmd.length()) return;

  logf("[CLI] RX: %s", cmd.c_str());
  cli_handle_command(cmd, io);
}

static void cli_execute_unlocked(const String& command, Stream& io){
  if(shelf_cli_handle(command, io)){
    return;
  }

  String upper = command;
  upper.toUpperCase();

  if(upper.startsWith("CTRL")){
    String args = command.substring(strlen("CTRL"));
    args.trim();
    if(!args.length()){
      io.println("ctrl_error=SYNTAX");
      log_line("[CLI] ctrl missing target");
      return;
    }

    int spaceIdx = args.indexOf(' ');
    String target = (spaceIdx < 0) ? args : args.substring(0, spaceIdx);
    String payload = (spaceIdx < 0) ? "" : args.substring(spaceIdx + 1);
    target.trim();
    target.toUpperCase();

    if(target == "HOME"){
      if(!g_uno_ready){
        io.println("ctrl_error=UNO_OFFLINE");
        log_line("[CLI] ctrl home aborted (UNO offline)");
        return;
      }
      bool ok = i2c_cmd_home();
      if(ok){
        io.println("ctrl_home=OK");
        log_line("[CLI] ctrl home ok");
      }else{
        io.println("ctrl_error=I2C");
        log_line("[CLI] ctrl home failed");
      }
      return;
    }

    if(!g_uno_ready){
      io.println("ctrl_error=UNO_OFFLINE");
      log_line("[CLI] ctrl aborted (UNO offline)");
      return;
    }

    CtrlToken tokens[8];
    size_t tokenCount = parse_tokens(payload, tokens, 8);

    if(target == "DRIVE" || target == "MOVE"){
      long vx = 0;
      long vy = 0;
      long w = 0;
      long t = 500;
      bool vxSet = false;
      bool vySet = false;
      bool wSet = false;
      bool tSet = false;
      bool error = false;

      for(size_t i = 0; i < tokenCount && !error; ++i){
        const String& key = tokens[i].key;
        const String& value = tokens[i].value;
        if(key == "VX"){ long tmp; if(!parse_int(value, tmp)){ error = true; break; } vx = tmp; vxSet = true; }
        else if(key == "VY"){ long tmp; if(!parse_int(value, tmp)){ error = true; break; } vy = tmp; vySet = true; }
        else if(key == "W" || key == "OMEGA"){ long tmp; if(!parse_int(value, tmp)){ error = true; break; } w = tmp; wSet = true; }
        else if(key == "T" || key == "TIME" || key == "MS"){ long tmp; if(!parse_int(value, tmp) || tmp <= 0){ error = true; break; } t = tmp; tSet = true; }
        else if(key.length()){ error = true; }
      }

      if(!vxSet && !vySet && !wSet){
        error = true;
      }

      if(error){
        io.println("ctrl_error=DRIVE_ARGS");
        log_line("[CLI] ctrl drive args invalid");
        return;
      }

      if(!i2c_cmd_drive(to_i16(vx), to_i16(vy), to_i16(w), to_i16(t))){
        io.println("ctrl_error=I2C");
        log_line("[CLI] ctrl drive failed");
        return;
      }
      io.printf("ctrl_drive=OK vx=%ld vy=%ld w=%ld t=%ld\n", vx, vy, w, t);
      logf("[CLI] ctrl drive vx=%ld vy=%ld w=%ld t=%ld", vx, vy, w, t);
      return;
    }

    if(target == "TURN"){
      long w = 0;
      long t = 500;
      bool wSet = false;
      bool error = false;

      for(size_t i = 0; i < tokenCount && !error; ++i){
        const String& key = tokens[i].key;
        const String& value = tokens[i].value;
        if(key == "DIR" || key == "DIRECTION"){
          if(value.equalsIgnoreCase("LEFT")){ w = 400; wSet = true; }
          else if(value.equalsIgnoreCase("RIGHT")){ w = -400; wSet = true; }
          else{ error = true; }
        }else if(key == "LEFT"){ w = 400; wSet = true; }
        else if(key == "RIGHT"){ w = -400; wSet = true; }
        else if(key == "W" || key == "OMEGA" || key == "SPEED"){ long tmp; if(!parse_int(value, tmp)){ error = true; break; } w = tmp; wSet = true; }
        else if(key == "T" || key == "TIME" || key == "MS"){ long tmp; if(!parse_int(value, tmp) || tmp <= 0){ error = true; break; } t = tmp; }
        else if(key.length()){ error = true; }
      }

      if(!wSet || error){
        io.println("ctrl_error=TURN_ARGS");
        log_line("[CLI] ctrl turn args invalid");
        return;
      }

      if(!i2c_cmd_drive(0, 0, to_i16(w), to_i16(t))){
        io.println("ctrl_error=I2C");
        log_line("[CLI] ctrl turn failed");
        return;
      }
      io.printf("ctrl_turn=OK w=%ld t=%ld\n", w, t);
      logf("[CLI] ctrl turn w=%ld t=%ld", w, t);
      return;
    }

    if(target == "ELEV" || target == "LIFT"){
      long h = 0;
      long speed = 150;
      long mode = 0;
      bool hSet = false;
      bool error = false;

      for(size_t i = 0; i < tokenCount && !error; ++i){
        const String& key = tokens[i].key;
        const String& value = tokens[i].value;
        if(key == "H" || key == "HEIGHT" || key == "MM"){ long tmp; if(!parse_int(value, tmp)){ error = true; break; } h = tmp; hSet = true; }
        else if(key == "SPEED" || key == "V" || key == "VEL"){ long tmp; if(!parse_int(value, tmp)){ error = true; break; } speed = tmp; }
        else if(key == "MODE"){ long tmp; if(!parse_int(value, tmp)){ error = true; break; } mode = tmp; }
        else if(key.length()){ error = true; }
      }

      if(!hSet || error){
        io.println("ctrl_error=ELEV_ARGS");
        log_line("[CLI] ctrl elev args invalid");
        return;
      }

      if(!i2c_cmd_elev(to_i16(h), to_i16(speed), static_cast<uint8_t>(mode))){
        io.println("ctrl_error=I2C");
        log_line("[CLI] ctrl elev failed");
        return;
      }
      io.printf("ctrl_elev=OK h=%ld speed=%ld mode=%ld\n", h, speed, mode);
      logf("[CLI] ctrl elev h=%ld speed=%ld mode=%ld", h, speed, mode);
      return;
    }

    if(target == "GRIP"){
      uint8_t cmd = 0;
      long arg = 0;
      bool cmdSet = false;
      bool argSet = false;
      bool error = false;

      for(size_t i = 0; i < tokenCount && !error; ++i){
        const String& key = tokens[i].key;
        const String& value = tokens[i].value;
        if(key == "OPEN"){ cmd = 0; cmdSet = true; }
        else if(key == "CLOSE"){ cmd = 1; cmdSet = true; }
        else if(key == "HOLD"){ cmd = 2; cmdSet = true; }
        else if(key == "CMD"){ long tmp; if(!parse_int(value, tmp)){ error = true; break; } cmd = static_cast<uint8_t>(tmp & 0xFF); cmdSet = true; }
        else if(key == "DEG" || key == "ANGLE"){ long tmp; if(!parse_int(value, tmp)){ error = true; break; } arg = tmp; argSet = true; }
        else if(key.length()){ error = true; }
      }

      if(!cmdSet && argSet){
        cmd = 2;
        cmdSet = true;
      }
      if(!cmdSet){
        cmd = 0;
        cmdSet = true;
      }

      if(error){
        io.println("ctrl_error=GRIP_ARGS");
        log_line("[CLI] ctrl grip args invalid");
        return;
      }

      if(!i2c_cmd_grip(cmd, to_i16(arg))){
        io.println("ctrl_error=I2C");
        log_line("[CLI] ctrl grip failed");
        return;
      }
      io.printf("ctrl_grip=OK cmd=%u arg=%ld\n", static_cast<unsigned>(cmd), arg);
      logf("[CLI] ctrl grip cmd=%u arg=%ld", static_cast<unsigned>(cmd), arg);
      return;
    }

    io.println("ctrl_error=UNKNOWN_TARGET");
    log_line("[CLI] ctrl unknown target");
    return;
  }

  if(upper.startsWith("I2C")){
    String args = command.substring(strlen("I2C"));
    args.trim();
    auto printDiag = [&](const I2CDiagnostics& diag){
      io.printf(
        "i2c_ready=%s i2c_using_fallback=%s i2c_current_hz=%lu i2c_primary_hz=%lu i2c_fallback_hz=%lu\n",
        diag.ready ? "true" : "false",
        diag.using_fallback ? "true" : "false",
        static_cast<unsigned long>(diag.current_hz),
        static_cast<unsigned long>(diag.primary_hz),
        static_cast<unsigned long>(diag.fallback_hz)
      );
      if(diag.last_ping_err != 0xFF){
        io.printf("i2c_last_ping_err=%u\n", static_cast<unsigned>(diag.last_ping_err));
      }
      if(diag.last_write_err_reg != 0xFF){
        io.printf(
          "i2c_last_write_err_reg=0x%02X code=%u\n",
          static_cast<unsigned>(diag.last_write_err_reg),
          static_cast<unsigned>(diag.last_write_err_code)
        );
      }
      if(diag.last_read_err_reg != 0xFF){
        io.printf(
          "i2c_last_read_err_reg=0x%02X code=%u\n",
          static_cast<unsigned>(diag.last_read_err_reg),
          static_cast<unsigned>(diag.last_read_err_code)
        );
      }
    };

    if(args.length() == 0 || args.equalsIgnoreCase("SCAN")){
      if(!i2c_is_ready()){
        io.println("i2c_error=BUS_UNAVAILABLE");
        log_line("[CLI] i2c scan skipped (bus not ready)");
        return;
      }
      I2CScanResult result = i2c_scan_bus(&io);
      io.printf("i2c_uno_found=%s\n", result.uno_found ? "true" : "false");
      log_line("[CLI] i2c scan handled");
      return;
    }

    if(args.equalsIgnoreCase("DIAG")){
      I2CDiagnostics diag = i2c_get_diagnostics();
      printDiag(diag);
      log_line("[CLI] i2c diag handled");
      return;
    }

    if(args.startsWith("FREQ")){
      String freqArgs = args.substring(strlen("FREQ"));
      freqArgs.trim();
      I2CDiagnostics diag = i2c_get_diagnostics();
      if(freqArgs.length() == 0 || freqArgs.equalsIgnoreCase("SHOW")){
        printDiag(diag);
        log_line("[CLI] i2c freq show");
        return;
      }
      if(freqArgs.equalsIgnoreCase("RESET")){
        i2c_reset_frequencies(true);
        I2CDiagnostics updated = i2c_get_diagnostics();
        printDiag(updated);
        log_line("[CLI] i2c freq reset");
        return;
      }

      CtrlToken freqTokens[4];
      size_t freqCount = parse_tokens(freqArgs, freqTokens, 4);
      if(freqCount == 0){
        io.println("i2c_error=FREQ_SYNTAX");
        log_line("[CLI] i2c freq syntax error");
        return;
      }
      bool error = false;
      bool applyNow = true;
      uint32_t primaryHz = diag.primary_hz ? diag.primary_hz : static_cast<uint32_t>(I2C_FREQ);
      uint32_t fallbackHz = diag.fallback_hz;

      for(size_t i = 0; i < freqCount && !error; ++i){
        const String& key = freqTokens[i].key;
        const String& value = freqTokens[i].value;
        if(key == "PRIMARY" || key == "P"){
          long tmp;
          if(!parse_int(value, tmp) || tmp <= 0){
            error = true;
            break;
          }
          primaryHz = static_cast<uint32_t>(tmp);
        }else if(key == "FALLBACK" || key == "F"){
          long tmp;
          if(!parse_int(value, tmp) || tmp < 0){
            error = true;
            break;
          }
          fallbackHz = static_cast<uint32_t>(tmp);
        }else if(key == "APPLY"){
          if(value.equalsIgnoreCase("NOW") || value.equalsIgnoreCase("TRUE") || value.equalsIgnoreCase("1")){
            applyNow = true;
          }else if(value.equalsIgnoreCase("LATER") || value.equalsIgnoreCase("FALSE") || value.equalsIgnoreCase("0")){
            applyNow = false;
          }else{
            error = true;
          }
        }else if(key.length()){
          error = true;
        }
      }

      if(error){
        io.println("i2c_error=FREQ_SYNTAX");
        log_line("[CLI] i2c freq syntax error");
        return;
      }

      if(!i2c_configure_frequencies(primaryHz, fallbackHz, applyNow)){
        io.println("i2c_error=FREQ_RANGE");
        log_line("[CLI] i2c freq invalid range");
        return;
      }

      I2CDiagnostics updated = i2c_get_diagnostics();
      printDiag(updated);
      io.printf("i2c_freq_applied=%s\n", applyNow ? "true" : "false");
      log_line("[CLI] i2c freq updated");
      return;
    }
    io.println("i2c_error=UNKNOWN_SUBCOMMAND");
    log_line("[CLI] i2c command invalid");
    return;
  }

  if(upper == "STATUS"){
    cli_print_status(io);
    log_line("[CLI] status handled");
    return;
  }

  if(upper.startsWith("CAMCFG")){
    String args = command.substring(strlen("CAMCFG"));
    args.trim();
    if(args.equalsIgnoreCase("?") || args.equalsIgnoreCase("INFO") || args.length() == 0){
      cli_print_camcfg(io);
      log_line("[CLI] camcfg handled");
      return;
    }

    args.replace(',', ' ');
    bool changed = false;
    bool error = false;
    String errorCode;
    int start = 0;
    while(start < args.length()){
      int end = args.indexOf(' ', start);
      if(end < 0) end = args.length();
      String token = args.substring(start, end);
      token.trim();
      if(token.length()){
        int eq = token.indexOf('=');
        if(eq < 0){
          error = true;
          errorCode = "SYNTAX";
          break;
        }
        String key = token.substring(0, eq);
        String value = token.substring(eq + 1);
        key.trim();
        value.trim();
        key.toUpperCase();
        if(key == "QUALITY" || key == "Q"){
          if(value.length() == 0){
            error = true;
            errorCode = "QUALITY";
            break;
          }
          bool numeric = true;
          for(size_t i = 0; i < value.length(); ++i){
            if(!isDigit(static_cast<unsigned char>(value[i]))){
              numeric = false;
              break;
            }
          }
          if(!numeric){
            error = true;
            errorCode = "QUALITY";
            break;
          }
          long q = value.toInt();
          if(!camera_http_set_quality(static_cast<uint8_t>(q))){
            error = true;
            errorCode = "QUALITY";
            break;
          }
          changed = true;
        }else if(key == "RES" || key == "RESOLUTION" || key == "FRAME"){
          if(!camera_http_set_resolution_by_name(value.c_str())){
            framesize_t frameValue;
            if(!camera_http_lookup_resolution(value.c_str(), &frameValue) || !camera_http_set_resolution(frameValue)){
              error = true;
              errorCode = "RESOLUTION";
              break;
            }
          }
          changed = true;
        }else{
          error = true;
          errorCode = "UNKNOWN_KEY";
          break;
        }
      }
      start = end + 1;
    }

    if(error){
      io.printf("camcfg_error=%s\n", errorCode.c_str());
      log_line("[CLI] camcfg error");
      return;
    }

    if(changed){
      camera_http_sync_sensor();
    }

    cli_print_camcfg(io);
    log_line("[CLI] camcfg handled");
    return;
  }

  if(upper == "BRAKE"){
    io.println(go_brake() ? "BRAKE=OK" : "BRAKE=FAIL");
    log_line("[CLI] brake handled");
    return;
  }

  if(upper.startsWith("CAMSTREAM")){
    String action = upper.substring(strlen("CAMSTREAM"));
    action.trim();
    if(action == "ON"){
      bool ok = camera_http_start();
      io.println(ok ? "CAMSTREAM=ON" : "CAMSTREAM=FAIL");
    }else if(action == "OFF"){
      camera_http_stop();
      io.println("CAMSTREAM=OFF");
    }else{
      io.printf("CAMSTREAM=%s\n", camera_http_is_running() ? "ON" : "OFF");
    }
    log_line("[CLI] camstream handled");
    return;
  }

  if(upper.startsWith("LOGS")){
    String args = command.substring(strlen("LOGS"));
    args.trim();
    uint32_t since = 0;
    size_t limit = 64;
    bool error = false;

    if(args.length()){
      args.replace(',', ' ');
      int start = 0;
      while(start < args.length()){
        int end = args.indexOf(' ', start);
        if(end < 0) end = args.length();
        String token = args.substring(start, end);
        token.trim();
        if(token.length()){
          int eq = token.indexOf('=');
          if(eq < 0){
            error = true;
            break;
          }
          String key = token.substring(0, eq);
          String value = token.substring(eq + 1);
          key.trim();
          value.trim();
          key.toUpperCase();
          if(key == "SINCE"){
            since = static_cast<uint32_t>(value.toInt());
          }else if(key == "LIMIT"){
            long parsed = value.toInt();
            if(parsed <= 0){
              error = true;
              break;
            }
            limit = static_cast<size_t>(parsed);
          }else{
            error = true;
            break;
          }
        }
        start = end + 1;
      }
    }

    if(error){
      io.println("logs_error=SYNTAX");
      log_line("[CLI] logs error");
      return;
    }

    LogDumpResult dump = log_dump(io, since, limit);
    logf(
      "[CLI] logs handled since=%lu limit=%u count=%u truncated=%u",
      static_cast<unsigned long>(since),
      static_cast<unsigned>(limit),
      static_cast<unsigned>(dump.count),
      dump.truncated ? 1U : 0U
    );
    return;
  }

  if(upper.startsWith("START")){
    if(i2c_seq()){
      st = ST_PICK;
      if(!g_uno_ready){
        io.println("START=UNO_OFFLINE");
        log_line("[CLI] start aborted (UNO offline)");
        return;
      }
      t_state_ms = millis();
      current_pick = C_NONE;
      if(camera_http_is_running()){
        camera_http_stop();
      }
      io.println("START=OK");
      log_line("[CLI] start handled");
    }else{
      io.println("START=FAIL");
      log_line("[CLI] start failed");
    }
    return;
  }

  io.println("ERR UNKNOWN_CMD");
  log_line("[CLI] unknown command");
}

static void cli_print_status(Stream& io){
  Status0 s0{};
  Status1 s1{};
  Lines ln{};
  Power pw{};
  DriveFB drv{};
  AuxFB aux{};
  Sens sns{};
  Odom od{};

  String err;
  auto appendErr = [&](const char* tag){
    if(err.length()) err += ',';
    err += tag;
  };

  if(g_uno_ready){
    bool ok0 = read_STATUS0(s0);
    bool ok1 = read_STATUS1(s1);
    bool okLines = read_LINES(ln);
    bool okPower = read_POWER(pw);
    bool okDrive = read_DRIVEFB(drv);
    bool okAux = read_AUXFB(aux);
    bool okSens = read_SENS(sns);
    bool okOdom = read_ODOM(od);

    if(!ok0) appendErr("STATUS0");
    if(!ok1) appendErr("STATUS1");
    if(!okLines) appendErr("LINES");
    if(!okPower) appendErr("POWER");
    if(!okSens) appendErr("SENS");
    if(!okOdom) appendErr("ODOM");

    if(!okDrive) memset(&drv, 0, sizeof(drv));
    if(!okAux) memset(&aux, 0, sizeof(aux));
    if(!okSens) memset(&sns, 0, sizeof(sns));
  }else{
    appendErr("UNO_MISSING");
    memset(&s0, 0, sizeof(s0));
    memset(&s1, 0, sizeof(s1));
    memset(&ln, 0, sizeof(ln));
    memset(&pw, 0, sizeof(pw));
    memset(&drv, 0, sizeof(drv));
    memset(&aux, 0, sizeof(aux));
    memset(&sns, 0, sizeof(sns));
    memset(&od, 0, sizeof(od));
  }

  bool wifiConnected = wifi_is_connected();
  IPAddress ip = wifi_local_ip();
  String ipStr = ip.toString();

  if(err.length()){
    io.printf("status_error=%s ", err.c_str());
  }

  io.printf(
    "state_id=%u seq_ack=%u err_flags=0x%04X elev_mm=%d grip_deg=%d line_left=%u line_right=%u line_thr=%u vbatt_mV=%u mps=%u estop=%u drive_left=%u drive_right=%u drive_res1=%u drive_res2=%u aux_lift=%u aux_grip=%u grip_enc=%d lift_enc=%d odo_left=%ld odo_right=%ld wifi_connected=%s wifi_ip=%s cam_streaming=%s\n",
    s0.state_id,
    s0.seq_ack,
    s0.err_flags,
    s1.elev_mm,
    s1.grip_deg,
    ln.L,
    ln.R,
    ln.thr,
    pw.vbatt_mV,
    pw.mps,
    pw.estop,
    drv.left_us,
    drv.right_us,
    drv.res1,
    drv.res2,
    aux.lift,
    aux.grip,
    sns.grip_enc_cnt,
    sns.lift_enc_cnt,
    (long)od.L,
    (long)od.R,
    wifiConnected ? "true" : "false",
    (wifiConnected ? ipStr.c_str() : ""),
    camera_http_is_running() ? "true" : "false"
  );
}

static void cli_print_camcfg(Stream& io){
  CameraHttpConfig cfg = camera_http_get_config();
  const char* name = camera_http_resolution_name(cfg.frame_size);
  if(!name){
    name = "UNKNOWN";
  }
  framesize_t maxSize = camera_http_get_supported_max_resolution();
  const char* maxName = camera_http_resolution_name(maxSize);
  if(!maxName){
    maxName = "UNKNOWN";
  }
  io.printf("cam_resolution=%s cam_quality=%u cam_max=%s\n", name, cfg.jpeg_quality, maxName);
}

namespace {

class BufferStream : public Stream {
 public:
  BufferStream() = default;

  int available() override { return 0; }
  int read() override { return -1; }
  int peek() override { return -1; }
  void flush() override {}

  size_t write(uint8_t value) override {
    buffer_ += static_cast<char>(value);
    return 1;
  }

  size_t write(const uint8_t* data, size_t size) override {
    for(size_t i = 0; i < size; ++i){
      buffer_ += static_cast<char>(data[i]);
    }
    return size;
  }

  const String& data() const { return buffer_; }

 private:
  String buffer_;
};

}  // namespace

void cli_handle_command(const String& command, Stream& output){
  if(!command.length()){
    return;
  }

  if(!g_cli_mutex){
    cli_execute_unlocked(command, output);
    return;
  }

  if(xSemaphoreTake(g_cli_mutex, pdMS_TO_TICKS(2000)) != pdTRUE){
    output.println("ERR CLI_LOCK_TIMEOUT");
  log_line("[CLI] mutex timeout");
    return;
  }

  cli_execute_unlocked(command, output);
  xSemaphoreGive(g_cli_mutex);
}

String cli_handle_command_capture(const String& command){
  BufferStream buffer;
  cli_handle_command(command, buffer);
  return buffer.data();
}

static I2CScanResult i2c_scan_bus(Stream* io){
  I2CScanResult result;
  if(!i2c_is_ready()){
    if(io){
      io->println("i2c_error=BUS_UNAVAILABLE");
    }
    log_line("[I2C] scan skipped (bus not ready)");
    return result;
  }
  String found;
  TwoWire& bus = i2c_bus();
  for(uint8_t addr = 1; addr < 0x7F; ++addr){
    bus.beginTransmission(addr);
    uint8_t error = bus.endTransmission();
    if(error == 0){
      if(found.length()){
        found += ' ';
      }
      char buf[7];
      snprintf(buf, sizeof(buf), "0x%02X", addr);
      found += buf;
      if(io){
        io->printf("i2c_device=%s\n", buf);
      }
      ++result.found;
      if(addr == I2C_ADDR_UNO){
        result.uno_found = true;
      }
    }else if(error == 4){
      ++result.errors;
      if(io){
        io->printf("i2c_error_addr=0x%02X code=%u\n", addr, static_cast<unsigned>(error));
      }
    }
    delay(2);
  }

  if(result.found){
    logf("[I2C] scan found %u device(s): %s", static_cast<unsigned>(result.found), found.c_str());
  }else{
    log_line("[I2C] scan found no devices");
  }

  if(result.errors){
    logf("[I2C] scan encountered %u error slot(s)", static_cast<unsigned>(result.errors));
  }

  if(io){
    io->printf("i2c_scan_total=%u\n", static_cast<unsigned>(result.found));
    if(result.errors){
      io->printf("i2c_scan_errors=%u\n", static_cast<unsigned>(result.errors));
    }
  }

  return result;
}

#endif  // MINIMAL_FIRMWARE