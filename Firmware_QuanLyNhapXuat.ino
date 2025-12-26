#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WiFiManager.h>
#include <SPI.h>
#include <MFRC522.h>
#include <time.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"

#include <Preferences.h>  
// ===== Device & Topics =====
constexpr const char* DEVICE_ID = "esp32-RFID";

// ===== NTP (UTC+7) =====
constexpr long gmtOffset_sec = 7 * 3600;
constexpr int daylightOffset_sec = 0;

// ===== Google Apps Script (Web App) =====
constexpr const char* gsScriptUrl =
  "https://script.google.com/macros/s/AKfycbxsy64_iWlZfNUdVyCrZBeaoq_LmOEOcOL6ANTZAQkVovwUM0jz0-lTghSBcCpjlg8g/exec";

// ===== RC522 (VSPI) =====
static const uint8_t PIN_SS = 5;    // SDA/SS
static const uint8_t PIN_RST = 22;  // RST
MFRC522 mfrc522(PIN_SS, PIN_RST);

// ===== Button (không dùng LED đơn) =====
constexpr uint8_t MODE_BTN = 33;              // nút ngoài ↔ GND
constexpr unsigned long MODE_DEBOUNCE = 200;  // ms
constexpr unsigned long LONG_PRESS_MS = 2000;

// ===== OLED I2C =====
#define OLED_RESET -1

// Bus 0 (Wire) cho màn 0.96"
#define OLED_MAIN_SDA 21
#define OLED_MAIN_SCL 27

// I2C_1 cho màn 0.91"
#define OLED_SMALL_SDA 25
#define OLED_SMALL_SCL 26

// I2C_2 cho màn 0.96"
TwoWire I2C_1(1);  // I2C controller số 1 trên ESP32

Adafruit_SSD1306 displayMain(128, 64, &Wire, OLED_RESET);    // 0.96" trên Wire
Adafruit_SSD1306 displaySmall(128, 32, &I2C_1, OLED_RESET);  // 0.91" trên I2C_1

bool oledMainOk = false;
bool oledSmallOk = false;

bool oledShowingEvent = false;            // true = 0.91" đang hiển thị kết quả quét
unsigned long oledLastEventMs = 0;        // thời điểm cuối cùng show event (0.91")
unsigned long oledLastClockUpdateMs = 0;  // thời điểm cuối cùng cập nhật màn hình chờ

// ===== Queue & Task cho Google Sheet =====
typedef struct {
  char action[8];  // "IN" / "OUT"
  char uid[32];
  char name[32];
  char stay[32];  // "1d 2h 3m 4s" hoặc ""
  char nsx[16];   // "dd/mm/yyyy"
  char hsd[16];   // "dd/mm/yyyy"
} GSheetEvent;

QueueHandle_t gsheetQueue = nullptr;

Preferences prefs;  // NEW: NVS

// ----- Forward declarations -----
void oledShowIdle();
void oledShowMessage(const String& l1, const String& l2, const String& l3);
void oledShowNameTimeDate(const String& name, const String& timeStr, const String& dateStr);
void resetAllStates();
void resetAllStatesRAM();

// ---------- Helpers ----------
String uidToString(const MFRC522::Uid& uid) {
  String s;
  for (byte i = 0; i < uid.size; i++) {
    if (uid.uidByte[i] < 16) s += "0";
    s += String(uid.uidByte[i], HEX);
    if (i + 1 < uid.size) s += ":";
  }
  s.toUpperCase();
  return s;
}

const char* mapUidToName(const String& uid) {
  // ===== PHÒNG 1 (6 - 11) =====
  if (uid == "91:93:13:05") return "Ca tim";
  if (uid == "84:74:D2:DE") return "Dau Cove";
  if (uid == "2C:5D:4A:03") return "Ca chua";
  if (uid == "64:69:49:03") return "Tac";
  if (uid == "F1:73:E5:00") return "Trung";
  if (uid == "8B:4B:8A:52") return "Dua leo";
  // ===== PHÒNG 2 (12 - 17) =====
  if (uid == "5C:F8:48:03") return "Gao";
  if (uid == "84:5D:4A:03") return "Banh keo";
  if (uid == "57:C3:4A:03") return "Bot mi";
  if (uid == "BC:F8:48:03") return "Ca phe";
  if (uid == "D9:17:69:06") return "Socola";
  if (uid == "B6:1C:6A:06") return "Tra";
  // ===== PHÒNG 3 (18 - 26) =====
  if (uid == "EB:BD:48:03") return "Thuoc vien";
  if (uid == "CB:1C:4A:03") return "My pham";
  if (uid == "52:9F:49:03") return "Nuoc hoa";
  if (uid == "52:B9:6B:06") return "Thuoc bot";
  if (uid == "2D:7C:6C:06") return "Vitamin";
  return "Khong xac dinh";
}

bool mapUidToRoomTemp(const String& uid, const char*& room, int& tmin, int& tmax) {
  // ===== PHÒNG 1 (6 - 11) =====
  if (uid == "91:93:13:05" ||  // Ca tim
      uid == "84:74:D2:DE" ||  // Dau Cove
      uid == "2C:5D:4A:03" ||  // Ca chua
      uid == "64:69:49:03" ||  // Tac
      uid == "F1:73:E5:00" ||  // Trung
      uid == "8B:4B:8A:52") {  // Dua leo
    room = "room1";
    tmin = 6;
    tmax = 11;
    return true;
  }
  // ===== PHÒNG 2 (12 - 17) =====
  if (uid == "5C:F8:48:03" ||  // Gao
      uid == "84:5D:4A:03" ||  // Banh keo
      uid == "57:C3:4A:03" ||  // Bot mi
      uid == "BC:F8:48:03" ||  // Ca phe
      uid == "D9:17:69:06" ||  // Socola
      uid == "B6:1C:6A:06") {  // Tra
    room = "room2";
    tmin = 12;
    tmax = 17;
    return true;
  }
  // ===== PHÒNG 3 (18 - 26) =====
  if (uid == "EB:BD:48:03" ||  // Thuoc vien
      uid == "CB:1C:4A:03" ||  // My pham
      uid == "52:9F:49:03" ||  // Nuoc hoa
      uid == "52:B9:6B:06" ||  // Thuoc bot
      uid == "2D:7C:6C:06") {  // Vitamin
    room = "room3";
    tmin = 18;
    tmax = 26;
    return true;
  }
  // Unknown
  room = "";
  tmin = 0;
  tmax = 0;
  return false;
}

String nowStr() {  // "YYYY-MM-DD HH:MM:SS"
  struct tm ti;
  if (getLocalTime(&ti)) {
    char buf[24];
    strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M:%S", &ti);
    return String(buf);
  }
  return "NTP chua san sang";
}

String urlEncode(const String& value) {
  String encoded = "";
  char c;
  char buf[4];
  for (int i = 0; i < value.length(); i++) {
    c = value.charAt(i);
    if (('a' <= c && c <= 'z') || ('A' <= c && c <= 'Z') || ('0' <= c && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~') {
      encoded += c;
    } else if (c == ' ') {
      encoded += '+';
    } else {
      snprintf(buf, sizeof(buf), "%%%02X", (unsigned char)c);
      encoded += buf;
    }
  }
  return encoded;
}

// Format epoch -> date dd/mm/YYYY
String formatEpochDate(time_t ep) {
  if (ep <= 0) return "-";
  struct tm ti;
  localtime_r(&ep, &ti);
  char buf[16];
  strftime(buf, sizeof(buf), "%d/%m/%Y", &ti);
  return String(buf);
}

// Format epoch -> time HH:MM
String formatEpochTimeHM(time_t ep) {
  if (ep <= 0) return "--:--";
  struct tm ti;
  localtime_r(&ep, &ti);
  char buf[8];
  strftime(buf, sizeof(buf), "%H:%M", &ti);
  return String(buf);
}

// ---------- Mode ----------
enum ActionMode { MODE_IN = 0,
                  MODE_OUT = 1 };
volatile ActionMode currentMode = MODE_IN;


void toggleMode() {
  currentMode = (currentMode == MODE_IN) ? MODE_OUT : MODE_IN;
  Serial.printf("Mode -> %s\n", (currentMode == MODE_IN) ? "IN" : "OUT");
  oledShowIdle();  // cập nhật màn hình chờ với mode mới
}

// Anti-duplicate gate
String lastUID = "";
unsigned long lastSeenMs = 0;
constexpr unsigned long holdOffMs = 800;

inline void resetAntiDuplicate() {
  lastUID = "";
  lastSeenMs = 0;
}

// ---------- OLED helpers ----------
void oledShowIdle() {
  oledShowingEvent = false;
  oledLastClockUpdateMs = millis();

  String ts = nowStr();  // "YYYY-MM-DD HH:MM:SS"
  String datePart, timePart;
  if (ts.length() >= 19) {
    datePart = ts.substring(0, 10);   // YYYY-MM-DD
    timePart = ts.substring(11, 19);  // HH:MM:SS
  } else {
    datePart = ts;
    timePart = "";
  }

  // Đổi YYYY-MM-DD -> dd/mm/YYYY
  String dateVN = datePart;
  if (datePart.length() == 10 && datePart.charAt(4) == '-' && datePart.charAt(7) == '-') {
    String y = datePart.substring(0, 4);
    String m = datePart.substring(5, 7);
    String d = datePart.substring(8, 10);
    dateVN = d + "/" + m + "/" + y;
  }

  const char* modeVN = (currentMode == MODE_IN) ? "Nhap hang" : "Xuat hang";

  // ==== OLED 0.96" ====
  if (oledMainOk) {
    displayMain.clearDisplay();
    displayMain.setTextColor(SSD1306_WHITE);
    // Dòng 1: Date
    displayMain.setTextSize(1);
    displayMain.setCursor(0, 0);
    displayMain.print("Date: ");
    displayMain.println(dateVN);
    // Dòng 2: Time
    displayMain.setCursor(0, 16);
    displayMain.print("Time: ");
    displayMain.println(timePart);
    // Dòng 3 + 4: Trang thai + Nhap/Xuat hang
    displayMain.setCursor(0, 32);
    displayMain.println("Trang thai:");

    displayMain.setTextSize(2);
    displayMain.setCursor(0, 44);
    displayMain.println(modeVN);

    displayMain.display();
  }

  // ==== OLED 0.91" ====
  if (oledSmallOk) {
    displaySmall.clearDisplay();
    displaySmall.setTextColor(SSD1306_WHITE);

    displaySmall.setTextSize(2);
    displaySmall.setCursor(0, 0);
    displaySmall.println("San sang");
    displaySmall.setCursor(0, 16);
    displaySmall.println("nhan hang");

    displaySmall.display();
  }
}

// Màn hình hiển thị sự kiện chung
void oledShowMessage(const String& l1, const String& l2, const String& l3) {
  oledShowingEvent = true;
  oledLastEventMs = millis();

  String ts = nowStr();  // "YYYY-MM-DD HH:MM:SS"
  String datePart, timePart;
  if (ts.length() >= 19) {
    datePart = ts.substring(0, 10);   // YYYY-MM-DD
    timePart = ts.substring(11, 19);  // HH:MM:SS
  } else {
    datePart = ts;
    timePart = "";
  }

  // Đổi YYYY-MM-DD -> dd/mm/YYYY
  String dateVN = datePart;
  if (datePart.length() == 10 && datePart.charAt(4) == '-' && datePart.charAt(7) == '-') {
    String y = datePart.substring(0, 4);
    String m = datePart.substring(5, 7);
    String d = datePart.substring(8, 10);
    dateVN = d + "/" + m + "/" + y;
  }

  const char* modeVN = (currentMode == MODE_IN) ? "Nhap hang" : "Xuat hang";

  // ==== OLED 0.96" ====
  if (oledMainOk) {
    displayMain.clearDisplay();
    displayMain.setTextColor(SSD1306_WHITE);

    // Date
    displayMain.setTextSize(1);
    displayMain.setCursor(0, 0);
    displayMain.print("Date: ");
    displayMain.println(dateVN);

    // Time
    displayMain.setCursor(0, 16);
    displayMain.print("Time: ");
    displayMain.println(timePart);

    // Trang thai
    displayMain.setCursor(0, 32);
    displayMain.println("Trang thai:");

    displayMain.setTextSize(2);
    displayMain.setCursor(0, 44);
    displayMain.println(modeVN);

    displayMain.display();
  }

  // ==== OLED 0.91" ====
  if (oledSmallOk) {
    displaySmall.clearDisplay();
    displaySmall.setTextColor(SSD1306_WHITE);
    // Gộp l2 + l3 thành line2 (nếu cần)
    String line2 = l2;
    if (l3.length() > 0) {
      if (line2.length() > 0) line2 += " ";
      line2 += l3;
    }
    // Dòng 1: to
    displaySmall.setTextSize(2);
    displaySmall.setCursor(0, 0);
    displaySmall.println(l1);
    // Dòng 2: to
    displaySmall.setCursor(0, 16);
    displaySmall.println(line2);

    displaySmall.display();
  }
}

// Màn hình hiển thị riêng cho TH: hàng đã có trong kho (INSIDE + MODE_IN)
void oledShowNameTimeDate(const String& name, const String& timeStr, const String& dateStr) {
  oledShowingEvent = true;
  oledLastEventMs = millis();

  String ts = nowStr();  // "YYYY-MM-DD HH:MM:SS"
  String datePart, timeNowPart;
  if (ts.length() >= 19) {
    datePart = ts.substring(0, 10);      // YYYY-MM-DD
    timeNowPart = ts.substring(11, 19);  // HH:MM:SS
  } else {
    datePart = ts;
    timeNowPart = "";
  }

  // Đổi YYYY-MM-DD -> dd/mm/YYYY
  String dateVN = datePart;
  if (datePart.length() == 10 && datePart.charAt(4) == '-' && datePart.charAt(7) == '-') {
    String y = datePart.substring(0, 4);
    String m = datePart.substring(5, 7);
    String d = datePart.substring(8, 10);
    dateVN = d + "/" + m + "/" + y;
  }

  const char* modeVN = (currentMode == MODE_IN) ? "Nhap hang" : "Xuat hang";

  // ==== OLED 0.96"  ====
  if (oledMainOk) {
    displayMain.clearDisplay();
    displayMain.setTextColor(SSD1306_WHITE);
    // Date
    displayMain.setTextSize(1);
    displayMain.setCursor(0, 0);
    displayMain.print("Date: ");
    displayMain.println(dateVN);
    // Time
    displayMain.setCursor(0, 16);
    displayMain.print("Time: ");
    displayMain.println(timeNowPart);
    // Trang thai
    displayMain.setCursor(0, 32);
    displayMain.println("Trang thai:");

    displayMain.setTextSize(2);
    displayMain.setCursor(0, 44);
    displayMain.println(modeVN);

    displayMain.display();
  }

  // ==== OLED 0.91" ====
  if (oledSmallOk) {
    displaySmall.clearDisplay();
    displaySmall.setTextColor(SSD1306_WHITE);
    // Dòng 1: tên hàng, to
    displaySmall.setTextSize(2);
    displaySmall.setCursor(0, 0);
    displaySmall.println(name);
    // Dòng 2: time bên trái, date bên phải (size=1)
    displaySmall.setTextSize(1);
    int16_t y = 18;
    // Thời gian bên trái
    displaySmall.setCursor(0, y);
    displaySmall.print(timeStr);  // "HH:MM"
    // Ngày đầy đủ bên phải: dd/mm/yyyy
    int charW = 6;  // với font mặc định size=1, mỗi ký tự ~6 px
    int16_t xDate = 128 - charW * dateStr.length();
    if (xDate < 0) xDate = 0;
    displaySmall.setCursor(xDate, y);
    displaySmall.print(dateStr);

    displaySmall.display();
  }
}
// ---------- WiFi (WiFiManager) & NTP ----------
void setup_wifi_wm() {
  WiFi.mode(WIFI_STA);

  WiFiManager wm;

  // Timeout cho cổng cấu hình
  wm.setConfigPortalTimeout(300);

  // Tên AP cấu hình
  String apName = String("RFID-Setup-") + DEVICE_ID;

  Serial.println();
  Serial.println("=== WiFiManager: autoConnect ===");
  if (!wm.autoConnect(apName.c_str(), "12345678")) {
    Serial.println("WiFiManager: Failed to connect. Rebooting...");
    delay(3000);
    ESP.restart();
  }
  Serial.println("WiFiManager: Connected!");
  Serial.print("IP: ");
  Serial.println(WiFi.localIP());
}

void setupTime() {
  if (WiFi.status() == WL_CONNECTED) {
    configTime(gmtOffset_sec, daylightOffset_sec, "pool.ntp.org", "time.nist.gov");
    for (int i = 0; i < 30; i++) {
      struct tm ti;
      if (getLocalTime(&ti)) break;
      delay(100);
    }
    Serial.println("Thoi gian he thong: " + nowStr());
  }
}
// ---------- State machine ----------
enum ItemState { NEVER_SEEN = 0,
                 INSIDE = 1,
                 OUTSIDE = 2 };
constexpr uint8_t NUM_UID = 17;
String knownUIDs[NUM_UID] = {
  "91:93:13:05",
  "84:74:D2:DE",
  "2C:5D:4A:03",
  "64:69:49:03",
  "F1:73:E5:00",
  "8B:4B:8A:52",
  "5C:F8:48:03",
  "84:5D:4A:03",
  "57:C3:4A:03",
  "BC:F8:48:03",
  "D9:17:69:06",
  "B6:1C:6A:06",
  "EB:BD:48:03",
  "CB:1C:4A:03",
  "52:9F:49:03",
  "52:B9:6B:06",
  "2D:7C:6C:06"
};
ItemState states[NUM_UID];
time_t lastInEpoch[NUM_UID];

String nsxArr[NUM_UID] = {
  "10/12/2025",  // 91:93:13:05  Ca tim   (7 ngày)
  "08/12/2025",  // 84:74:D2:DE  Dau Cove (8 ngày)
  "01/12/2025",  // 2C:5D:4A:03  Ca chua  (28 ngày)
  "05/12/2025",  // 64:69:49:03  Tac      (14 ngày)
  "14/12/2025",  // F1:73:E5:00  Trung    (14 ngày)
  "06/12/2025",  // 8B:4B:8A:52  Dua leo  (10 ngày)

  "01/11/2025",  // 5C:F8:48:03  Gao      (12 tháng)
  "15/08/2025",  // 84:5D:4A:03  Banh keo (10 tháng)
  "10/10/2025",  // 57:C3:4A:03  Bot mi   (6 tháng)
  "28/12/2024",  // BC:F8:48:03  Ca phe   (12 tháng)
  "05/09/2025",  // D9:17:69:06  Socola   (10 tháng)
  "12/09/2025",  // B6:1C:6A:06  Tra      (12 tháng)

  "01/01/2025",  // EB:BD:48:03  Thuoc vien (24 tháng)
  "15/02/2025",  // CB:1C:4A:03  My pham    (24 tháng)
  "20/03/2025",  // 52:9F:49:03  Nuoc hoa   (36 tháng)
  "10/05/2025",  // 52:B9:6B:06  Thuoc bot  (24 tháng)
  "25/06/2025"   // 2D:7C:6C:06  Vitamin    (24 tháng)
};
String hsdArr[NUM_UID] = {
  "17/12/2025",  // Ca tim   = 10/12/2025 + 7 ngày
  "16/12/2025",  // Dau Cove = 08/12/2025 + 8 ngày
  "29/12/2025",  // Ca chua  = 01/12/2025 + 28 ngày
  "19/12/2025",  // Tac      = 05/12/2025 + 14 ngày
  "28/12/2025",  // Trung    = 14/12/2025 + 14 ngày
  "16/12/2025",  // Dua leo  = 06/12/2025 + 10 ngày

  "01/11/2026",  // Gao      = 01/11/2025 + 12 tháng
  "15/06/2026",  // Banh keo = 15/08/2025 + 10 tháng
  "10/04/2026",  // Bot mi   = 10/10/2025 + 6 tháng
  "28/12/2025",  // Ca phe   = 28/12/2024 + 12 tháng
  "05/07/2026",  // Socola   = 05/09/2025 + 10 tháng
  "12/09/2026",  // Tra      = 12/09/2025 + 12 tháng

  "01/01/2027",  // Thuoc vien = 01/01/2025 + 24 tháng
  "15/02/2027",  // My pham    = 15/02/2025 + 24 tháng
  "20/03/2028",  // Nuoc hoa   = 20/03/2025 + 36 tháng
  "10/05/2027",  // Thuoc bot  = 10/05/2025 + 24 tháng
  "25/06/2027"   // Vitamin    = 25/06/2025 + 24 tháng
};
// ===== Lưu / tải trạng thái hàng trong NVS (flash) =====
void saveStatesToNVS() {
  uint8_t stRaw[NUM_UID];
  for (int i = 0; i < NUM_UID; i++) {
    stRaw[i] = (uint8_t)states[i];
  }

  if (!prefs.begin("rfidstore", false)) {
    Serial.println("[NVS] begin() failed (save)");
    return;
  }

  prefs.putBytes("states", stRaw, sizeof(stRaw));
  prefs.putBytes("lastIn", lastInEpoch, sizeof(lastInEpoch));
  prefs.end();
  Serial.println("[NVS] Saved states to flash");
}

void loadStatesFromNVS() {
  if (!prefs.begin("rfidstore", true)) {
    Serial.println("[NVS] begin() failed (load)");
    return;
  }

  size_t lenStates = prefs.getBytesLength("states");
  size_t lenLastIn = prefs.getBytesLength("lastIn");

  if (lenStates == sizeof(uint8_t) * NUM_UID && lenLastIn == sizeof(lastInEpoch)) {
    uint8_t stRaw[NUM_UID];
    prefs.getBytes("states", stRaw, sizeof(stRaw));
    prefs.getBytes("lastIn", lastInEpoch, sizeof(lastInEpoch));

    for (int i = 0; i < NUM_UID; i++) {
      if (stRaw[i] <= (uint8_t)OUTSIDE) {
        states[i] = (ItemState)stRaw[i];
      } else {
        states[i] = NEVER_SEEN;
        lastInEpoch[i] = 0;
      }
    }
    Serial.println("[NVS] Loaded states from flash");
  } else {
    // Chưa có dữ liệu hợp lệ → giữ NEVER_SEEN
    for (int i = 0; i < NUM_UID; i++) {
      states[i] = NEVER_SEEN;
      lastInEpoch[i] = 0;
    }
    Serial.println("[NVS] No valid data, init to NEVER_SEEN");
  }

  prefs.end();
}

void clearStatesNVS() {
  if (!prefs.begin("rfidstore", false)) return;
  prefs.clear();
  prefs.end();
  Serial.println("[NVS] Cleared flash states");
}

String formatDuration(unsigned long totalSec) {
  unsigned long days = totalSec / 86400;
  totalSec %= 86400;
  unsigned long hours = totalSec / 3600;
  totalSec %= 3600;
  unsigned long mins = totalSec / 60;
  unsigned long secs = totalSec % 60;

  String s;
  if (days) {
    s += String(days) + "d ";
  }
  if (hours || days) {
    s += String(hours) + "h ";
  }
  if (mins || hours || days) {
    s += String(mins) + "m ";
  }
  s += String(secs) + "s";
  return s;
}

int indexOfUID(const String& uid) {
  for (int i = 0; i < NUM_UID; i++)
    if (knownUIDs[i] == uid) return i;
  return -1;
}

void resetAllStatesRAM() {  // NEW
  for (int i = 0; i < NUM_UID; i++) {
    states[i] = NEVER_SEEN;
    lastInEpoch[i] = 0;
  }
  resetAntiDuplicate();
}

// Reset toàn bộ: RAM + NVS (dùng cho RESET thật sự)
void resetAllStates() {  // NEW
  resetAllStatesRAM();
  clearStatesNVS();
}

// ---------- Google Sheet helper ----------
void sendToGoogleSheet(const String& action,
                       const String& uid,
                       const char* name,
                       const String& stayStr,
                       const char* nsx,
                       const char* hsd,
                       const char* room,
                       int tmin,
                       int tmax) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[GSHEET] WiFi not connected, skip");
    return;
  }

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  http.setConnectTimeout(3000);  // timeout 3s

  String url = String(gsScriptUrl) + "?sts=write" + "&io=" + urlEncode(action) + "&item=" + urlEncode(String(name)) + "&stay=" + urlEncode(stayStr) + "&uid=" + urlEncode(uid) + "&nsx=" + urlEncode(String(nsx)) + "&hsd=" + urlEncode(String(hsd)) + "&room=" + urlEncode(String(room)) + "&tmin=" + urlEncode(String(tmin)) + "&tmax=" + urlEncode(String(tmax));

  Serial.println("[GSHEET] GET " + url);

  if (!http.begin(client, url)) {
    Serial.println("[GSHEET] http.begin() failed");
    return;
  }

  int httpCode = http.GET();
  if (httpCode > 0) {
    String payload = http.getString();
    Serial.printf("[GSHEET] Code=%d, body=%s\n", httpCode, payload.c_str());
  } else {
    Serial.printf("[GSHEET] Error, code=%d\n", httpCode);
  }
  http.end();
}

// ---------- Task xử lý queue Google Sheet ----------
void gsheetTask(void* pv) {
  GSheetEvent evt;
  for (;;) {
    if (xQueueReceive(gsheetQueue, &evt, portMAX_DELAY) == pdTRUE) {
      String action = String(evt.action);
      String uid = String(evt.uid);
      String name = String(evt.name);
      String stay = String(evt.stay);

      Serial.printf("[GSHEET-TASK] Sending %s | uid=%s | name=%s | stay=%s | nsx=%s | hsd=%s\n",
                    action.c_str(), uid.c_str(), name.c_str(), stay.c_str(),
                    evt.nsx, evt.hsd);

      const char* room = "";
      int tmin = 0, tmax = 0;

      if (action == "RESET") {
        room = "system";
        tmin = 0;
        tmax = 0;
      } else {
        mapUidToRoomTemp(uid, room, tmin, tmax);
      }

      sendToGoogleSheet(action, uid, name.c_str(), stay, evt.nsx, evt.hsd, room, tmin, tmax);
    }
  }
}

// ---------- I2C helper ----------
uint8_t detectSSD1306Addr(TwoWire& bus, const char* tag) {
  Serial.print("[I2C DETECT] ");
  Serial.println(tag);

  uint8_t candidate1 = 0x3C;
  uint8_t candidate2 = 0x3D;

  // Thử 0x3C
  bus.beginTransmission(candidate1);
  uint8_t err = bus.endTransmission();
  if (err == 0) {
    Serial.print("  Found device at 0x");
    Serial.println(candidate1, HEX);
    return candidate1;
  } else {
    Serial.print("  No device at 0x");
    Serial.print(candidate1, HEX);
    Serial.print(" (err=");
    Serial.print(err);
    Serial.println(")");
  }

  // Thử 0x3D
  bus.beginTransmission(candidate2);
  err = bus.endTransmission();
  if (err == 0) {
    Serial.print("  Found device at 0x");
    Serial.println(candidate2, HEX);
    return candidate2;
  } else {
    Serial.print("  No device at 0x");
    Serial.print(candidate2, HEX);
    Serial.print(" (err=");
    Serial.print(err);
    Serial.println(")");
  }

  Serial.println("  No SSD1306 found on this bus");
  return 0;
}

// ---------- Setup ----------
void setup() {
  Serial.begin(115200);
  while (!Serial) {}

  pinMode(MODE_BTN, INPUT_PULLUP);

  // OLED init: 2 bus I2C khác nhau
  Wire.begin(OLED_MAIN_SDA, OLED_MAIN_SCL);     // Bus 0 cho màn 0.96"
  I2C_1.begin(OLED_SMALL_SDA, OLED_SMALL_SCL);  // Bus 1 cho màn 0.91"

  // Tự detect địa chỉ 0x3C/0x3D trên từng bus
  uint8_t mainAddr = detectSSD1306Addr(Wire, "Wire (OLED 0.96)");
  uint8_t smallAddr = detectSSD1306Addr(I2C_1, "I2C_1 (OLED 0.91)");

  if (mainAddr != 0) {
    oledMainOk = displayMain.begin(SSD1306_SWITCHCAPVCC, mainAddr);
  } else {
    oledMainOk = false;
  }

  if (smallAddr != 0) {
    oledSmallOk = displaySmall.begin(SSD1306_SWITCHCAPVCC, smallAddr);
  } else {
    oledSmallOk = false;
  }

  if (!oledMainOk) Serial.println(F("Main OLED 0.96 init failed"));
  if (!oledSmallOk) Serial.println(F("Small OLED 0.91 init failed"));

  if (oledMainOk) {
    displayMain.clearDisplay();
    displayMain.setTextSize(1);
    displayMain.setTextColor(SSD1306_WHITE);
    displayMain.setCursor(0, 0);
    displayMain.println("RFID Coldroom");
    displayMain.println("Starting...");
    displayMain.display();
  }
  if (oledSmallOk) {
    displaySmall.clearDisplay();
    displaySmall.setTextSize(2);
    displaySmall.setTextColor(SSD1306_WHITE);
    displaySmall.setCursor(0, 0);
    displaySmall.println("RFID");
    displaySmall.setCursor(0, 16);
    displaySmall.println("Coldroom");
    displaySmall.display();
  }

  // ==== Kết nối WiFi bằng WiFiManager ====
  setup_wifi_wm();
  setupTime();

  SPI.begin();  
  mfrc522.PCD_Init();
  mfrc522.PCD_DumpVersionToSerial();

  resetAllStatesRAM();
  loadStatesFromNVS();

  // Queue & task Google Sheet
  gsheetQueue = xQueueCreate(10, sizeof(GSheetEvent));
  if (gsheetQueue == NULL) {
    Serial.println("[GSHEET] Failed to create queue");
  } else {
    xTaskCreatePinnedToCore(
      gsheetTask,
      "gsheetTask",
      8192,
      NULL,
      1,
      NULL,
      1);
    Serial.println("[GSHEET] Queue & Task started");
  }

  Serial.println("\n=== San sang. Quet the len RC522 ===");
  Serial.println("- Lan dau OUT se canh bao: 'San pham khong co trong kho'");
  Serial.println("- Cho phep chu ky IN ↔ OUT vo han");

  oledShowIdle();
}

// ---------- Loop ----------
void loop() {
  unsigned long nowMs = millis();

  // 1) Nếu 0.91" đang hiển thị kết quả quét > 5s thì tự quay về màn hình chờ
  if (oledShowingEvent && (long)(nowMs - oledLastEventMs) >= 5000) {
    oledShowIdle();
  }

  // 2) Nếu đang ở màn hình chờ thì mỗi 1 giây vẽ lại để cập nhật thời gian trên 0.96"
  if (!oledShowingEvent && (long)(nowMs - oledLastClockUpdateMs) >= 1000) {
    oledShowIdle();
  }

  // Nút toggle mode (debounce + long-press reset)
  static unsigned long lastEdgeMs = 0, pressStart = 0;
  static int lastBtn = HIGH;
  int b = digitalRead(MODE_BTN);
  unsigned long ms = millis();

  if (b != lastBtn && (ms - lastEdgeMs) > MODE_DEBOUNCE) {
    lastEdgeMs = ms;
    lastBtn = b;
    if (b == LOW) {
      pressStart = ms;
    } else {
      if (pressStart && (ms - pressStart) < LONG_PRESS_MS) {
        toggleMode();
        resetAntiDuplicate();
      }
      pressStart = 0;
    }
  }
  if (pressStart && (ms - pressStart) >= LONG_PRESS_MS) {
    resetAllStates();
    Serial.println("[RESET] all states by long-press");

    // Gửi 1 dòng log lên Google Sheet
    if (gsheetQueue) {
      GSheetEvent evt;
      memset(&evt, 0, sizeof(evt));
      strncpy(evt.action, "RESET", sizeof(evt.action) - 1);
      strncpy(evt.uid, "-", sizeof(evt.uid) - 1);
      strncpy(evt.name, "System", sizeof(evt.name) - 1);
      strncpy(evt.stay, "-", sizeof(evt.stay) - 1);
      strncpy(evt.nsx, "-", sizeof(evt.nsx) - 1);
      strncpy(evt.hsd, "-", sizeof(evt.hsd) - 1);
      xQueueSend(gsheetQueue, &evt, 0);
    }
    pressStart = 0;
  }
  // RFID
  if (!mfrc522.PICC_IsNewCardPresent()) return;
  if (!mfrc522.PICC_ReadCardSerial()) return;

  String uid = uidToString(mfrc522.uid);
  String ts = nowStr();
  time_t nowEpoch = time(nullptr);

  if (nowEpoch < 100000) {  // NTP chưa sync xong
    Serial.println("[TIME] NTP chua san sang, bo qua quet");
    oledShowMessage("NTP chua", "san sang", "");
    mfrc522.PICC_HaltA();
    mfrc522.PCD_StopCrypto1();
    return;
  }

  if (uid == lastUID && (ms - lastSeenMs) < holdOffMs) {
    mfrc522.PICC_HaltA();
    mfrc522.PCD_StopCrypto1();
    return;
  }
  lastUID = uid;
  lastSeenMs = ms;

  const char* name = mapUidToName(uid);
  int idx = indexOfUID(uid);

  auto enqueueGSheet = [&](const char* action, const String& stayStr) {
    if (gsheetQueue == NULL || idx < 0) return;

    GSheetEvent evt;
    memset(&evt, 0, sizeof(evt));

    strncpy(evt.action, action, sizeof(evt.action) - 1);
    strncpy(evt.uid, uid.c_str(), sizeof(evt.uid) - 1);
    strncpy(evt.name, name, sizeof(evt.name) - 1);
    strncpy(evt.stay, stayStr.c_str(), sizeof(evt.stay) - 1);
    strncpy(evt.nsx, nsxArr[idx].c_str(), sizeof(evt.nsx) - 1);
    strncpy(evt.hsd, hsdArr[idx].c_str(), sizeof(evt.hsd) - 1);

    if (xQueueSend(gsheetQueue, &evt, 0) != pdPASS) {
      Serial.println("[GSHEET] Queue full, drop event");
    }
  };

  // UID không xác định
  if (idx < 0 || String(name) == "Khong xac dinh") {
    String msg = "UID chua gan";
    Serial.printf("[ALERT] %s | UID=%s | Mode=%s\n", msg.c_str(), uid.c_str(),
                  (currentMode == MODE_IN) ? "IN" : "OUT");
    oledShowMessage("UID chua", "gan:", uid);
    mfrc522.PICC_HaltA();
    mfrc522.PCD_StopCrypto1();
    return;
  }

  ItemState st = states[idx];

  // ================== LOGIC HIỂN THỊ + GỬI NSX/HSD ==================
  if (st == NEVER_SEEN) {
    if (currentMode == MODE_OUT) {
      // Xuất hàng, nhưng chưa từng IN → hàng không có trong kho
      String msg = "San pham khong co trong kho";
      Serial.printf("[ALERT] %s | UID=%s (%s)\n", msg.c_str(), uid.c_str(), name);
      oledShowMessage(String(name), "Khong co", "");
      resetAntiDuplicate();
    } else {
      // Nhập hàng lần đầu
      lastInEpoch[idx] = nowEpoch;
      enqueueGSheet("IN", "");
      states[idx] = INSIDE;

      saveStatesToNVS();  // NEW: lưu trạng thái sau khi IN

      Serial.printf("[OK ] IN -> %s (%s)\n", uid.c_str(), name);
      oledShowMessage(String(name), "Da nhan", "");
    }
  } else if (st == INSIDE) {
    if (currentMode == MODE_IN) {
      // Nhập hàng, nhưng đã trong kho
      String msg = "San pham da trong kho";
      Serial.printf("[NOTE] %s | UID=%s (%s)\n", msg.c_str(), uid.c_str(), name);

      String dateStr = formatEpochDate(lastInEpoch[idx]);
      String timeFirst = formatEpochTimeHM(lastInEpoch[idx]);
      oledShowNameTimeDate(String(name), timeFirst, dateStr);
    } else {
      // Xuất hàng
      unsigned long staySec = 0;
      if (lastInEpoch[idx] != 0 && nowEpoch >= lastInEpoch[idx]) {
        staySec = (unsigned long)(nowEpoch - lastInEpoch[idx]);
      }
      String stayStr = formatDuration(staySec);
      enqueueGSheet("OUT", stayStr);

      states[idx] = OUTSIDE;
      lastInEpoch[idx] = 0;

      saveStatesToNVS();  // NEW: lưu sau khi OUT

      Serial.printf("[OK ] OUT -> %s (%s), stay=%s\n",
                    uid.c_str(), name, stayStr.c_str());
      oledShowMessage(String(name), "Da xuat", "");
    }
  } else {  // st == OUTSIDE
    if (currentMode == MODE_OUT) {
      // Xuất hàng nhưng đang OUT
      String msg = "San pham khong co trong kho";
      Serial.printf("[ALERT] %s | UID=%s (%s)\n", msg.c_str(), uid.c_str(), name);
      oledShowMessage(String(name), "Khong co", "");
    } else {
      // Nhập lại hàng đã OUT trước đó
      lastInEpoch[idx] = nowEpoch;
      enqueueGSheet("IN", "");
      states[idx] = INSIDE;

      saveStatesToNVS();  // NEW: lưu sau khi IN lại

      Serial.printf("[OK ] IN (restock) -> %s (%s)\n", uid.c_str(), name);
      oledShowMessage(String(name), "Da nhan", "");
    }
  }

  mfrc522.PICC_HaltA();
  mfrc522.PCD_StopCrypto1();
}
