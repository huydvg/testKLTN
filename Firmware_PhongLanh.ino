#define SERIAL_PLOTTER_MODE 1
#if SERIAL_PLOTTER_MODE
#define LOGI(...) \
  do {           \
  } while (0)
#else
#define LOGI(...) Serial.printf(__VA_ARGS__)
#endif

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WiFiManager.h>
#include "DHTesp.h"
#include <ArduinoJson.h>
#include <PubSubClient.h>

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SH110X.h>
#include <time.h>
#include <math.h>

// ================== Cấu hình phần cứng ==================
#define DHT_PIN 4
#define DOOR_PIN 33
#define RELAY_ACTIVE_HIGH 1
#define DOOR_ACTIVE_LOW 1
#define BUZZER_PIN 26

// ======= BTS7960 (Peltier) =======
const int PIN_R_EN = 18;
const int PIN_L_EN = 5;
const int PIN_RPWM = 19;  // PWM chiều làm lạnh
const int PIN_LPWM = 23;  // luôn 0 để không đảo chiều

const int PWM_MAX = 255;
const int MIN_DUTY = 0;

// ===== OLED =====
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_ADDR 0x3C
#define OLED_RESET -1
Adafruit_SH1106G display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

DHTesp dht;

// ================== MQTT (HiveMQ Cloud) ==================
const char* mqtt_server = "dcede8aa2beb496b980ed91f6804346e.s1.eu.hivemq.cloud";
const int mqtt_port = 8883;
const char* mqtt_username = "Huy-DTVT17B";
const char* mqtt_password = "GiaHuy2008@";

// ================== CHỌN PHÒNG ==================
#ifndef ROOM_IDX
#define ROOM_IDX 3
#endif

#if ROOM_IDX == 1
#define ROOM_STR "room1"
#define DEVICE_ID "esp32-room1"
#elif ROOM_IDX == 2
#define ROOM_STR "room2"
#define DEVICE_ID "esp32-room2"
#elif ROOM_IDX == 3
#define ROOM_STR "room3"
#define DEVICE_ID "esp32-room3"
#else
#error "ROOM_IDX must be 1..3"
#endif

// ================== MQTT TOPICS ==================
#define PUB_STATE_TOPIC "coldroom/" ROOM_STR "/out1"
#define PUB_TELE_TOPIC "coldroom/" ROOM_STR "/DHT22"

#define SUB_PELTIER_CMD_TOPIC "coldroom/" ROOM_STR "/peltier_cmd"
#define PUB_PELTIER_STATE_TOPIC "coldroom/" ROOM_STR "/peltier_state"
#define PUB_PELTIER_TELE_TOPIC "coldroom/" ROOM_STR "/peltier_tele"

#define SUB_SYSTEM_CMD_TOPIC "coldroom/" ROOM_STR "/system_cmd"

// ============ MQTT CLIENT =============
WiFiClientSecure espClient;
PubSubClient client(espClient);

// ================== Thời gian / cờ ==================
volatile unsigned long isrDebounceMs = 0;
volatile bool doorChangedFlag = false;

unsigned long lastTeleMs = 0;
unsigned long lastUiMs = 0;
unsigned long lastPeltierTeleMs = 0;

// ================== Trạng thái ==================
int doorOpen01 = 0;

// ======= Peltier =======
enum PeltierMode : uint8_t { PELTIER_MANUAL = 0,
                             PELTIER_AUTO = 1,
                             PELTIER_OFF = 2 };
volatile PeltierMode gPeltierMode = PELTIER_MANUAL;
volatile bool gPeltierEnable = true;
int gPeltierManualDuty = 0;
int gPeltierMinDuty = MIN_DUTY;
int gPeltierMaxDuty = PWM_MAX;
int gPeltierDuty = 0;

// ===== AUTO params =====
float gAutoSetpointC = 10.0f;
float gAutoBoostBandC = 2.0f;
float gAutoHysC = 0.3f;
int gAutoMinDuty = 80;
int gAutoMaxDuty = 255;

// ================== NTP (UTC+7) ==================
const char* ntpServer = "vn.pool.ntp.org";
const long gmtOffset_sec = 7 * 3600;
const int daylightOffset = 0;

// ================== Sensor values ==================
float gTempC = NAN;
float gTempRaw = NAN;
float gTempKal = NAN;

float gHumi = NAN;
float gHumiRaw = NAN;  // 
float gHumiKal = NAN;  // 

// ================== WiFi default ==================
const char* DEFAULT_WIFI_SSID = "GQui";
const char* DEFAULT_WIFI_PASS = "20082812";
const unsigned long WIFI_TRY_SAVED_MS = 8000;
const unsigned long WIFI_TRY_DEFAULT_MS = 12000;

// ================== Alarm nhiệt độ ==================
float gAlarmLowC = 0.0f;
float gAlarmHighC = 0.0f;
float gClearLowC = 0.0f;
float gClearHighC = 0.0f;

const unsigned long ALARM_ON_MS = 700;
const unsigned long ALARM_OFF_MS = 300;

volatile bool alarmTemp = false;
bool beepState = false;
unsigned long nextBeepSwitchMs = 0;
int alarmDir = 0;
volatile bool gAlarmEnable = false;

//  MASTER SYSTEM
volatile bool gSystemEnable = true;

// ===== OLED power control =====
volatile bool gOledOn = true;

// ================== Helper ==================
inline String two(int v) {
  return (v < 10) ? "0" + String(v) : String(v);
}

inline void buzzerWrite(bool on) {
  if (RELAY_ACTIVE_HIGH) digitalWrite(BUZZER_PIN, on ? HIGH : LOW);
  else digitalWrite(BUZZER_PIN, on ? LOW : HIGH);
}

void publishMessage(const char* topic, const String& payload, bool retained) {
  if (!client.connected()) return;
  client.publish(topic, payload.c_str(), retained);
}

static inline int to01_any(JsonVariant v) {
  if (v.is<bool>()) return v.as<bool>() ? 1 : 0;
  if (v.is<int>()) return v.as<int>() ? 1 : 0;
  if (v.is<float>()) return (fabsf(v.as<float>()) > 0.5f) ? 1 : 0;
  String s = v.as<String>();
  s.trim();
  if (s.equalsIgnoreCase("true") || s == "1" || s.equalsIgnoreCase("on")) return 1;
  return 0;
}

inline void applyBuzzerOutput() {
  if (!gSystemEnable) {
    buzzerWrite(false);
    return;
  }
  if (!gAlarmEnable) {
    buzzerWrite(false);
    return;
  }
  buzzerWrite(beepState);
}

// ============ forward ============
bool publishState();
void publishPeltierState();
void publishPeltierTele();
void applyPeltierDuty(int duty);
void applySystemEnable(bool en);
void attachDoorIsrIfNeeded();
void servicePeltierAuto();
void updateAlarmFromTemp();
void serviceBeep();

void oledPower(bool on) {
  if (on == gOledOn) return;
  gOledOn = on;

  if (gOledOn) {
    display.oled_command(SH110X_DISPLAYON);
    delay(20);
    display.clearDisplay();
    display.display();
  } else {
    display.clearDisplay();
    display.display();
    display.oled_command(SH110X_DISPLAYOFF);
  }
}

// ================== TẮT PWM SẠCH (KHÔNG ledc) ==================
void pwmHardOffPin(int pin) {
  analogWrite(pin, 0);
  delay(1);
  pinMode(pin, OUTPUT);
  digitalWrite(pin, LOW);
}

void peltierPwmHardOff() {
  pwmHardOffPin(PIN_RPWM);
  pwmHardOffPin(PIN_LPWM);
}

// ================== Door ==================
inline int readDoorOpen01() {
  int level = digitalRead(DOOR_PIN);
  if (DOOR_ACTIVE_LOW) return (level == HIGH) ? 1 : 0;
  else return (level == LOW) ? 1 : 0;
}

void IRAM_ATTR doorIsr() {
  unsigned long now = millis();
  if (now - isrDebounceMs > 80) {
    doorChangedFlag = true;
    isrDebounceMs = now;
  }
}

void attachDoorIsrIfNeeded() {
  detachInterrupt(digitalPinToInterrupt(DOOR_PIN));
  if (gSystemEnable) {
    attachInterrupt(digitalPinToInterrupt(DOOR_PIN), doorIsr, CHANGE);
  }
}

// ================== State publish ==================
bool publishState() {
  if (!client.connected()) return false;
  StaticJsonDocument<320> d;
  d["door"] = doorOpen01;
  d["peltierDuty"] = gPeltierDuty;
  d["alarmTemp"] = alarmTemp ? 1 : 0;
  d["alarmDir"] = alarmDir;
  d["alarmEnable"] = gAlarmEnable ? 1 : 0;
  d["systemEnable"] = gSystemEnable ? 1 : 0;

  char buf[320];
  serializeJson(d, buf);
  return client.publish(PUB_STATE_TOPIC, buf, true);
}

// ================== Peltier ==================
inline int clampDuty(int d) {
  if (d < 0) d = 0;
  if (d > PWM_MAX) d = PWM_MAX;
  if (d > 0 && d < gPeltierMinDuty) d = gPeltierMinDuty;
  if (d > gPeltierMaxDuty) d = gPeltierMaxDuty;
  return d;
}

void applyPeltierDuty(int duty) {
  if (!gSystemEnable) {
    peltierPwmHardOff();
    gPeltierDuty = 0;
    return;
  }

  int out = (gPeltierEnable && gPeltierMode != PELTIER_OFF) ? clampDuty(duty) : 0;
  analogWrite(PIN_RPWM, out);
  analogWrite(PIN_LPWM, 0);
  gPeltierDuty = out;
}

void publishPeltierState() {
  if (!client.connected()) return;
  StaticJsonDocument<520> d;

  const char* modeStr =
    (gPeltierMode == PELTIER_AUTO) ? "auto" : (gPeltierMode == PELTIER_OFF) ? "off"
                                                                            : "manual";

  d["mode"] = modeStr;
  d["enable"] = gPeltierEnable ? 1 : 0;
  d["manualDuty"] = gPeltierManualDuty;
  d["duty"] = gPeltierDuty;
  d["minDuty"] = gPeltierMinDuty;
  d["maxDuty"] = gPeltierMaxDuty;

  d["setpointC"] = gAutoSetpointC;
  d["boostBandC"] = gAutoBoostBandC;
  d["autoHysC"] = gAutoHysC;
  d["autoMinDuty"] = gAutoMinDuty;
  d["autoMaxDuty"] = gAutoMaxDuty;

  d["alarmLowC"] = gAlarmLowC;
  d["alarmHighC"] = gAlarmHighC;
  d["clearLowC"] = gClearLowC;
  d["clearHighC"] = gClearHighC;

  d["alarmTemp"] = alarmTemp ? 1 : 0;
  d["alarmDir"] = alarmDir;

  d["alarmEnable"] = gAlarmEnable ? 1 : 0;
  d["systemEnable"] = gSystemEnable ? 1 : 0;

  d["r_en"] = (digitalRead(PIN_R_EN) == HIGH) ? 1 : 0;
  d["l_en"] = (digitalRead(PIN_L_EN) == HIGH) ? 1 : 0;

  char buf[520];
  serializeJson(d, buf);
  publishMessage(PUB_PELTIER_STATE_TOPIC, String(buf), true);
}

void publishPeltierTele() {
  if (!client.connected()) return;
  StaticJsonDocument<280> d;
  d["duty"] = gPeltierDuty;
  d["pct"] = (int)roundf(100.0f * gPeltierDuty / PWM_MAX);
  d["alarmTemp"] = alarmTemp ? 1 : 0;
  d["alarmDir"] = alarmDir;
  d["alarmEnable"] = gAlarmEnable ? 1 : 0;
  d["systemEnable"] = gSystemEnable ? 1 : 0;

  char buf[280];
  serializeJson(d, buf);
  publishMessage(PUB_PELTIER_TELE_TOPIC, String(buf), true);
}

// ================== AUTO control ==================
void servicePeltierAuto() {
  if (!gSystemEnable) return;
  if (gPeltierMode != PELTIER_AUTO) return;
  if (!gPeltierEnable) {
    applyPeltierDuty(0);
    return;
  }
  if (!isfinite(gTempC)) return;

  float sp = gAutoSetpointC;
  float boost = (gAutoBoostBandC > 0.05f) ? gAutoBoostBandC : 0.5f;
  float hys = (gAutoHysC >= 0.0f) ? gAutoHysC : 0.0f;

  int minD = constrain(gAutoMinDuty, 0, PWM_MAX);
  int maxD = constrain(gAutoMaxDuty, 0, PWM_MAX);
  if (maxD < minD) {
    int t = minD;
    minD = maxD;
    maxD = t;
  }

  int target = gPeltierDuty;
  if (gTempC <= sp - hys) target = 0;
  else if (gTempC >= sp + hys) {
    float e = gTempC - sp;
    float ratio = e / boost;
    ratio = fminf(fmaxf(ratio, 0.0f), 1.0f);
    target = minD + (int)roundf(ratio * (maxD - minD));
  }

  static unsigned long lastApply = 0;
  if (millis() - lastApply >= 250) {
    lastApply = millis();
    applyPeltierDuty(target);
  }
}

// ================== Alarm logic ==================
void forceAlarmOffNow(const char* reason) {
  alarmTemp = false;
  alarmDir = 0;
  beepState = false;
  nextBeepSwitchMs = millis();
  applyBuzzerOutput();
  LOGI("[ALARM] FORCE OFF (%s)\n", reason ? reason : "");
}

void updateAlarmFromTemp() {
  if (!isfinite(gTempC)) return;

  if (!gSystemEnable) {
    if (alarmTemp || beepState) forceAlarmOffNow("systemEnable=0");
    return;
  }
  if (!gAlarmEnable) {
    if (alarmTemp || beepState) forceAlarmOffNow("alarmEnable=0");
    return;
  }

  if (!alarmTemp) {
    if (gTempC < gAlarmLowC) {
      alarmTemp = true;
      alarmDir = -1;
    } else if (gTempC > gAlarmHighC) {
      alarmTemp = true;
      alarmDir = +1;
    }

    if (alarmTemp) {
      beepState = true;
      nextBeepSwitchMs = millis() + ALARM_ON_MS;
      publishState();
      applyBuzzerOutput();
    }
    return;
  }

  if (gTempC >= gClearLowC && gTempC <= gClearHighC) {
    alarmTemp = false;
    alarmDir = 0;
    beepState = false;
    publishState();
    applyBuzzerOutput();
  }
}

void serviceBeep() {
  if (!gSystemEnable || !gAlarmEnable) {
    if (beepState) {
      beepState = false;
      applyBuzzerOutput();
    }
    return;
  }
  if (!alarmTemp) return;
  if ((long)(millis() - nextBeepSwitchMs) >= 0) {
    beepState = !beepState;
    nextBeepSwitchMs = millis() + (beepState ? ALARM_ON_MS : ALARM_OFF_MS);
    applyBuzzerOutput();
  }
}

void setDefaultTempBandsByRoom() {
#if ROOM_IDX == 1
  gAlarmLowC = 5.5f;
  gAlarmHighC = 11.5f;
  gClearLowC = 6.5f;
  gClearHighC = 10.5f;
  gAutoSetpointC = 8.0f;
#elif ROOM_IDX == 2
  gAlarmLowC = 11.5f;
  gAlarmHighC = 17.5f;
  gClearLowC = 12.5f;
  gClearHighC = 16.5f;
  gAutoSetpointC = 14.0f;
#elif ROOM_IDX == 3
  gAlarmLowC = 17.5f;
  gAlarmHighC = 26.5f;
  gClearLowC = 18.5f;
  gClearHighC = 25.5f;
  gAutoSetpointC = 22.0f;
#endif
}

// ================== MASTER SYSTEM (TẮT NGOẠI VI) ==================
void applySystemEnable(bool en) {
  if (gSystemEnable == en) return;

  gSystemEnable = en;
  LOGI("[SYSTEM] systemEnable = %d\n", gSystemEnable ? 1 : 0);

  if (!gSystemEnable) {
    gPeltierEnable = false;
    gPeltierMode = PELTIER_OFF;

    peltierPwmHardOff();
    gPeltierDuty = 0;

    digitalWrite(PIN_R_EN, LOW);
    digitalWrite(PIN_L_EN, LOW);

    gAlarmEnable = false;
    forceAlarmOffNow("system off");
    buzzerWrite(false);

    detachInterrupt(digitalPinToInterrupt(DOOR_PIN));
    oledPower(false);

  } else {
    digitalWrite(PIN_R_EN, HIGH);
    digitalWrite(PIN_L_EN, HIGH);

    pinMode(PIN_RPWM, OUTPUT);
    pinMode(PIN_LPWM, OUTPUT);
    analogWrite(PIN_RPWM, 0);
    analogWrite(PIN_LPWM, 0);

    gPeltierEnable = false;
    gPeltierMode = PELTIER_OFF;
    gPeltierDuty = 0;

    attachDoorIsrIfNeeded();
    oledPower(true);
  }

  applyBuzzerOutput();
  publishPeltierState();
  publishState();
}

// ================== WiFi ưu tiên ==================
bool try_connect_saved_wifi(unsigned long timeoutMs) {
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.persistent(true);

  WiFi.begin();

  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && (millis() - t0) < timeoutMs) {
    delay(250);
  }
  return (WiFi.status() == WL_CONNECTED);
}

bool try_connect_default_wifi(unsigned long timeoutMs) {
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.persistent(true);

  WiFi.disconnect(false, false);
  delay(200);
  WiFi.begin(DEFAULT_WIFI_SSID, DEFAULT_WIFI_PASS);

  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && (millis() - t0) < timeoutMs) {
    delay(250);
  }
  return (WiFi.status() == WL_CONNECTED);
}

void start_wifimanager_portal() {
  WiFi.mode(WIFI_STA);

  WiFiManager wm;
  wm.setConfigPortalTimeout(300);

  String apName = String("Coldroom-Setup-") + DEVICE_ID;

  if (!wm.autoConnect(apName.c_str(), "12345678")) {
    delay(3000);
    ESP.restart();
  }
}

void setup_wifi_priority() {
  if (try_connect_saved_wifi(WIFI_TRY_SAVED_MS)) return;
  if (try_connect_default_wifi(WIFI_TRY_DEFAULT_MS)) return;
  start_wifimanager_portal();
}

// ================== MQTT callback ==================
void callback(char* topic, byte* payload, unsigned int length) {
  String in;
  in.reserve(length + 1);
  for (unsigned int i = 0; i < length; i++) in += (char)payload[i];

  if (String(topic) == SUB_SYSTEM_CMD_TOPIC) {
    StaticJsonDocument<256> doc;
    if (deserializeJson(doc, in)) return;
    if (doc.containsKey("systemEnable")) {
      bool en = (to01_any(doc["systemEnable"]) == 1);
      applySystemEnable(en);
    }
    return;
  }

  if (String(topic) == SUB_PELTIER_CMD_TOPIC) {
    if (!gSystemEnable) {
      publishPeltierState();
      publishState();
      return;
    }

    StaticJsonDocument<768> doc;
    if (deserializeJson(doc, in)) return;

    JsonObject obj = doc.as<JsonObject>();
    if (obj.containsKey("peltier") && obj["peltier"].is<JsonObject>()) {
      obj = obj["peltier"].as<JsonObject>();
    }

    bool needApply = false;
    bool needPub = false;

    if (obj.containsKey("alarmEnable")) {
      bool en = (to01_any(obj["alarmEnable"]) == 1);
      if (gAlarmEnable != en) {
        gAlarmEnable = en;
        needPub = true;
        if (!gAlarmEnable) forceAlarmOffNow("web disabled");
        else updateAlarmFromTemp();
      }
    }

    if (obj.containsKey("enable")) {
      gPeltierEnable = (to01_any(obj["enable"]) == 1);
      needApply = true;
      needPub = true;
    }
    if (obj.containsKey("mode")) {
      String m = obj["mode"].as<String>();
      m.toLowerCase();
      if (m == "manual") gPeltierMode = PELTIER_MANUAL;
      else if (m == "auto") gPeltierMode = PELTIER_AUTO;
      else gPeltierMode = PELTIER_OFF;
      needApply = true;
      needPub = true;
    }
    if (obj.containsKey("duty")) {
      gPeltierManualDuty = constrain(obj["duty"].as<int>(), 0, PWM_MAX);
      if (gPeltierMode == PELTIER_MANUAL) needApply = true;
      needPub = true;
    }

    if (obj.containsKey("minDuty")) {
      gPeltierMinDuty = constrain(obj["minDuty"].as<int>(), 0, PWM_MAX);
      needPub = true;
    }
    if (obj.containsKey("maxDuty")) {
      gPeltierMaxDuty = constrain(obj["maxDuty"].as<int>(), 0, PWM_MAX);
      needPub = true;
    }

    if (obj.containsKey("setpointC")) {
      gAutoSetpointC = obj["setpointC"].as<float>();
      needPub = true;
    }
    if (obj.containsKey("boostBandC")) {
      gAutoBoostBandC = obj["boostBandC"].as<float>();
      needPub = true;
    }
    if (obj.containsKey("autoHysC")) {
      gAutoHysC = obj["autoHysC"].as<float>();
      needPub = true;
    }
    if (obj.containsKey("autoMinDuty")) {
      gAutoMinDuty = constrain(obj["autoMinDuty"].as<int>(), 0, PWM_MAX);
      needPub = true;
    }
    if (obj.containsKey("autoMaxDuty")) {
      gAutoMaxDuty = constrain(obj["autoMaxDuty"].as<int>(), 0, PWM_MAX);
      needPub = true;
    }

    bool bandChanged = false;
    if (obj.containsKey("alarmLowC")) {
      gAlarmLowC = obj["alarmLowC"].as<float>();
      bandChanged = true;
    }
    if (obj.containsKey("alarmHighC")) {
      gAlarmHighC = obj["alarmHighC"].as<float>();
      bandChanged = true;
    }
    if (obj.containsKey("clearLowC")) {
      gClearLowC = obj["clearLowC"].as<float>();
      bandChanged = true;
    }
    if (obj.containsKey("clearHighC")) {
      gClearHighC = obj["clearHighC"].as<float>();
      bandChanged = true;
    }

    if (bandChanged) {
      if (gAlarmLowC > gAlarmHighC) {
        float t = gAlarmLowC;
        gAlarmLowC = gAlarmHighC;
        gAlarmHighC = t;
      }
      if (gClearLowC > gClearHighC) {
        float t = gClearLowC;
        gClearLowC = gClearHighC;
        gClearHighC = t;
      }
      needPub = true;
      updateAlarmFromTemp();
    }

    if (needApply) {
      int target = 0;
      if (!gPeltierEnable || gPeltierMode == PELTIER_OFF) target = 0;
      else if (gPeltierMode == PELTIER_MANUAL) target = gPeltierManualDuty;
      else target = gPeltierDuty;
      applyPeltierDuty(target);
    }

    if (needPub) {
      publishPeltierState();
      publishState();
    }
  }
}

// ================== MQTT reconnect ==================
void reconnect() {
  while (!client.connected()) {
    String clientID = String(DEVICE_ID) + "-" + String(random(0xffff), HEX);
    if (client.connect(clientID.c_str(), mqtt_username, mqtt_password)) {
      client.subscribe(SUB_PELTIER_CMD_TOPIC);
      client.subscribe(SUB_SYSTEM_CMD_TOPIC);
      publishState();
      publishPeltierState();
    } else {
      delay(5000);
    }
  }
}

// ================== OLED draw helpers ==================
int16_t textWidth(const String& s, uint8_t size) {
  int16_t x1, y1;
  uint16_t w, h;
  display.setTextSize(size);
  display.getTextBounds(s.c_str(), 0, 0, &x1, &y1, &w, &h);
  return (int16_t)w;
}

void drawRight(int16_t rightMargin, int16_t y, const String& s, uint8_t size) {
  int16_t w = textWidth(s, size);
  int16_t x = SCREEN_WIDTH - w - rightMargin;
  if (x < 0) x = 0;
  display.setTextSize(size);
  display.setCursor(x, y);
  display.print(s);
}

void drawOLED() {
  const int MID_X = 25;
  display.clearDisplay();
  display.setTextColor(SH110X_WHITE);
  display.setTextWrap(false);
  display.cp437(true);

  struct tm tmnow;
  bool haveTime = getLocalTime(&tmnow, 200);

  display.setTextSize(1);
  display.setCursor(0, 0);
  if (haveTime) display.print("Date:" + two(tmnow.tm_mday) + "/" + two(tmnow.tm_mon + 1) + "/" + String(1900 + tmnow.tm_year));
  else display.print("Date --/--/----");

  display.setCursor(0, 10);
  if (haveTime) display.print("Time:" + two(tmnow.tm_hour) + ":" + two(tmnow.tm_min) + ":" + two(tmnow.tm_sec));
  else display.print("T --:--:--");

  drawRight(4, 0, String(ROOM_STR), 1);

  String doorLine = String("Door:") + (doorOpen01 ? "OP" : "CL");
  drawRight(4, 18, doorLine, 1);

  display.setCursor(0, 22);
  if (!gSystemEnable) display.print("SYS:OFF");
  else if (!gAlarmEnable) display.print("AL:DIS");
  else if (alarmTemp) display.print(alarmDir < 0 ? "AL:LOW" : "AL:HIGH");
  else display.print("AL:OFF");

  display.setTextSize(2);
  display.setCursor(0, 32);
  display.print("T:");
  display.setCursor(0, 50);
  display.print("H:");

  {  // Temp
    String tVal = isnan(gTempC) ? String("--.- ") : (String(gTempC, 1) + " ");
    tVal += (char)248;
    tVal += "C";
    int16_t w = textWidth(tVal, 2);
    int16_t x = SCREEN_WIDTH - w - 4;
    if (x < MID_X) x = MID_X;
    display.setCursor(x, 32);
    display.print(tVal);
  }

  {  // Humi
    String hVal = isnan(gHumi) ? String("--.- %") : (String(gHumi, 1) + "  %");
    int16_t w = textWidth(hVal, 2);
    int16_t x = SCREEN_WIDTH - w - 4;
    if (x < MID_X) x = MID_X;
    display.setCursor(x, 50);
    display.print(hVal);
  }

  display.display();
}

// ================== Kalman ==================
struct Kalman1D {
  float x, P, Q, R;
  bool inited;
  Kalman1D(float q = 0.02f, float r = 0.25f)
    : x(0), P(1), Q(q), R(r), inited(false) {}
  inline float update(float z) {
    if (!isfinite(z)) return inited ? x : z;
    if (!inited) {
      x = z;
      P = 1.0f;
      inited = true;
      return x;
    }
    P += Q;
    float K = P / (P + R);
    x = x + K * (z - x);
    P = (1.0f - K) * P;
    return x;
  }
};
Kalman1D kfTemp(0.02f, 0.25f), kfHumi(0.03f, 0.64f);

// ================== Serial Plotter helper (4 cột) ==================
// Cột: T_raw  T_kal  H_raw  H_kal  (tab-separated, không chữ)
static inline void plot4(float a, float b, float c, float d) {
  if (isfinite(a)) Serial.printf("%.2f", a);
  Serial.print('\t');
  if (isfinite(b)) Serial.printf("%.2f", b);
  Serial.print('\t');
  if (isfinite(c)) Serial.printf("%.2f", c);
  Serial.print('\t');
  if (isfinite(d)) Serial.printf("%.2f", d);
  Serial.print('\n');
}

// ================== SETUP ==================
void setup() {
  Serial.begin(115200);

  dht.setup(DHT_PIN, DHTesp::DHT22);

  setup_wifi_priority();
  setDefaultTempBandsByRoom();

  espClient.setInsecure();
  client.setServer(mqtt_server, mqtt_port);
  client.setCallback(callback);
  client.setBufferSize(1024);

  configTime(gmtOffset_sec, daylightOffset, ntpServer);

  pinMode(BUZZER_PIN, OUTPUT);
  buzzerWrite(false);

  pinMode(DOOR_PIN, INPUT_PULLUP);
  doorOpen01 = readDoorOpen01();
  attachDoorIsrIfNeeded();

  pinMode(PIN_R_EN, OUTPUT);
  pinMode(PIN_L_EN, OUTPUT);
  pinMode(PIN_RPWM, OUTPUT);
  pinMode(PIN_LPWM, OUTPUT);

  digitalWrite(PIN_R_EN, HIGH);
  digitalWrite(PIN_L_EN, HIGH);
  analogWrite(PIN_RPWM, 0);
  analogWrite(PIN_LPWM, 0);

  Wire.begin();
  display.begin(OLED_ADDR, true);
  display.clearDisplay();
  display.setTextColor(SH110X_WHITE);
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.println("ESP32 ColdRoom");
  display.println("OLED Ready...");
  display.display();

  randomSeed(micros());

  lastTeleMs = millis();
  lastUiMs = lastTeleMs;
  lastPeltierTeleMs = lastTeleMs;
}

// ================== LOOP ==================
void loop() {
  if (WiFi.status() == WL_CONNECTED) {
    if (!client.connected()) reconnect();
    client.loop();
  }

  // đọc DHT vẫn chạy để bạn giám sát (dù SYS OFF)
  if (millis() - lastTeleMs > 1000) {
    float h_raw = dht.getHumidity();
    float t_raw = dht.getTemperature();

    float t_f = isfinite(t_raw) ? kfTemp.update(t_raw) : NAN;
    float h_f = isfinite(h_raw) ? kfHumi.update(h_raw) : NAN;

    // lưu RAW + Kalman cho cả nhiệt độ & độ ẩm
    gTempRaw = t_raw;
    gTempKal = t_f;
    gHumiRaw = h_raw;
    gHumiKal = h_f;

    // Serial Plotter: 4 cột (Traw, Tkal, Hraw, Hkal)
    plot4(gTempRaw, gTempKal, gHumiRaw, gHumiKal);

    // giá trị dùng cho hệ thống (ưu tiên Kalman)
    if (isfinite(t_f)) gTempC = t_f;
    else if (isfinite(t_raw)) gTempC = t_raw;

    if (isfinite(h_f)) gHumi = h_f;
    else if (isfinite(h_raw)) gHumi = h_raw;

    // Chỉ chạy điều khiển khi SYS ON
    if (gSystemEnable) {
      servicePeltierAuto();
      updateAlarmFromTemp();
    } else {
      buzzerWrite(false);
      alarmTemp = false;
      beepState = false;
      gPeltierDuty = 0;
    }
    // MQTT telemetry
    StaticJsonDocument<320> doc;

    if (gSystemEnable && isfinite(gTempC)) doc["temperature"] = gTempC;
    else doc["temperature"] = serialized("null");

    if (gSystemEnable && isfinite(gHumi)) doc["humidity"] = gHumi;
    else doc["humidity"] = serialized("null");

    doc["peltierDuty"] = gPeltierDuty;
    doc["alarmTemp"] = alarmTemp ? 1 : 0;
    doc["alarmDir"] = alarmDir;
    doc["alarmEnable"] = gAlarmEnable ? 1 : 0;
    doc["systemEnable"] = gSystemEnable ? 1 : 0;

    char buf[320];
    serializeJson(doc, buf);
    publishMessage(PUB_TELE_TOPIC, buf, true);

    lastTeleMs = millis();
  }

  serviceBeep();

  if (gSystemEnable && (millis() - lastPeltierTeleMs > 1000)) {
    lastPeltierTeleMs = millis();
    publishPeltierTele();
  }

  if (gSystemEnable && doorChangedFlag) {
    doorChangedFlag = false;
    int newDoor = readDoorOpen01();
    if (newDoor != doorOpen01) {
      doorOpen01 = newDoor;
      publishState();
    }
  }

  if (millis() - lastUiMs >= 1000) {
    lastUiMs = millis();
    if (gSystemEnable && gOledOn) drawOLED();
  }
}
