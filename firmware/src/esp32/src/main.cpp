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

void setup(){
  Serial.begin(115200);
  delay(1000);
  log_sink_init();
  log_line("[ESP32] Boot");
  g_cli_mutex = xSemaphoreCreateMutex();
  if(!g_cli_mutex){
    log_line("[CLI] mutex allocation failed");
  }
  wifi_init();
  cli_ws_init();
  camera_http_init();
  // I2C
  i2c_init();
  g_uno_ready = i2c_ping_uno();
  if(!g_uno_ready){
    log_line("[ESP32] UNO not responding; automation disabled");
  }
  g_last_uno_check_ms = millis();
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
    bool okOdom = read_ODOM(od);

    if(!ok0) appendErr("STATUS0");
    if(!ok1) appendErr("STATUS1");
    if(!okLines) appendErr("LINES");
    if(!okPower) appendErr("POWER");
    if(!okOdom) appendErr("ODOM");

    if(!okDrive) memset(&drv, 0, sizeof(drv));
    if(!okAux) memset(&aux, 0, sizeof(aux));
  }else{
    appendErr("UNO_MISSING");
    memset(&s0, 0, sizeof(s0));
    memset(&s1, 0, sizeof(s1));
    memset(&ln, 0, sizeof(ln));
    memset(&pw, 0, sizeof(pw));
    memset(&drv, 0, sizeof(drv));
    memset(&aux, 0, sizeof(aux));
    memset(&od, 0, sizeof(od));
  }

  bool wifiConnected = wifi_is_connected();
  IPAddress ip = wifi_local_ip();
  String ipStr = ip.toString();

  if(err.length()){
    io.printf("status_error=%s ", err.c_str());
  }

  io.printf(
    "state_id=%u seq_ack=%u err_flags=0x%04X elev_mm=%d grip_deg=%d line_left=%u line_right=%u line_thr=%u vbatt_mV=%u mps=%u estop=%u drive_fl=%u drive_fr=%u drive_rl=%u drive_rr=%u aux_lift=%u aux_grip=%u odo_left=%ld odo_right=%ld wifi_connected=%s wifi_ip=%s cam_streaming=%s\n",
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
    drv.fl,
    drv.fr,
    drv.rl,
    drv.rr,
    aux.lift,
    aux.grip,
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