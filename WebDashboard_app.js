(function () {
      // ===== MQTT CONFIG =====
      const HOST = 'dcede8aa2beb496b980ed91f6804346e.s1.eu.hivemq.cloud';
      const PORT = 8884;
      const PATH = '/mqtt';
      const USERNAME = 'Huy-DTVT17B';
      const PASSWORD = 'GiaHuy2008@';
      const WS_URL = `wss://${HOST}:${PORT}${PATH}`;

      const ROOMS = ['room1', 'room2', 'room3'];
      let currentRoom = localStorage.getItem('coldroom.currentRoom') || 'room1';

      const TOPIC = {
        rfid: 'coldroom/esp32-RFID/rfid',
        tele: 'coldroom/+/DHT22',
        state: 'coldroom/+/out1',
        pub: room => `coldroom/${room}/system_cmd`,
        teleOf: room => `coldroom/${room}/DHT22`,
        stateOf: room => `coldroom/${room}/out1`,
        peltierState: 'coldroom/+/peltier_state',
        peltierTele: 'coldroom/+/peltier_tele',
        peltierCmdOf: room => `coldroom/${room}/peltier_cmd`,
      };

      function defaultRange(room) {
        if (room === 'room1') return { low: 6.0, high: 11.0 };
        if (room === 'room2') return { low: 12.0, high: 17.0 };
        return { low: 18.0, high: 26.0 };
      }

      const HYST = 0.5;

      function bandsFromLowHigh(low, high) {
        const lo = Number(low), hi = Number(high);
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
        const L = Math.min(lo, hi);
        const H = Math.max(lo, hi);

        const clearLow = L + HYST;
        const clearHigh = H - HYST;
        if (clearHigh <= clearLow) {
          const mid = (L + H) / 2;
          return {
            low: L, high: H,
            alarmLowC: L - HYST,
            alarmHighC: H + HYST,
            clearLowC: mid - 0.05,
            clearHighC: mid + 0.05,
          };
        }

        return {
          low: L, high: H,
          alarmLowC: L - HYST,
          alarmHighC: H + HYST,
          clearLowC: L + HYST,
          clearHighC: H - HYST,
        };
      }

      function deriveLowHighFromBands(b) {
        if (Number.isFinite(b?.clearLowC) && Number.isFinite(b?.clearHighC)) {
          return { low: b.clearLowC - HYST, high: b.clearHighC + HYST };
        }
        if (Number.isFinite(b?.alarmLowC) && Number.isFinite(b?.alarmHighC)) {
          return { low: b.alarmLowC + HYST, high: b.alarmHighC - HYST };
        }
        return null;
      }

      // ===== DOM header =====
      const hdrWrap = document.getElementById('hdrWrap');
      const hdrDot = document.getElementById('hdrDot');
      const hdrSt = document.getElementById('hdrSt');
      function setHdr(text, cls) {
        hdrWrap.hidden = false;
        hdrSt.textContent = text;
        hdrDot.className = 'dot ' + (cls || '');
      }

      // ===== Tabs =====
      const tabRFIDBtn = document.getElementById('tabRFIDBtn');
      const tabRoomBtn = document.getElementById('tabRoomBtn');
      const tabReportBtn = document.getElementById('tabReportBtn');
      const tabRFID = document.getElementById('tabRFID');
      const tabRoom = document.getElementById('tabRoom');

      function activate(tab) {
        [tabRFIDBtn, tabRoomBtn].forEach(b => b.classList.remove('active'));
        [tabRFID, tabRoom].forEach(s => s.classList.remove('active'));
        if (tab === 'rfid') { tabRFIDBtn.classList.add('active'); tabRFID.classList.add('active'); }
        else if (tab === 'room') { tabRoomBtn.classList.add('active'); tabRoom.classList.add('active'); }
        else { tab = 'rfid'; tabRFIDBtn.classList.add('active'); tabRFID.classList.add('active'); }
        try { localStorage.setItem('coldroom.activeTab', tab); } catch { }
      }

      tabRFIDBtn.addEventListener('click', () => activate('rfid'));
      tabRoomBtn.addEventListener('click', () => activate('room'));
      const SHEET_URL = 'https://docs.google.com/spreadsheets/d/1eU0HPzWhDaeF8UvmeHoQMh0lxxxX-ds1ir5rA1F6dus/edit';

      tabReportBtn.addEventListener('click', () => {
        window.open(SHEET_URL, '_blank', 'noopener');
      });

      let lastTab = localStorage.getItem('coldroom.activeTab') || 'rfid';
      if (lastTab === 'report') lastTab = 'rfid';
      activate(lastTab);

      // Helpers
      const debounce = (fn, ms = 180) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
      const parseRoomFromTopic = topic => {
        const parts = topic.split('/');
        return (parts.length >= 3 && parts[0] === 'coldroom') ? parts[1] : '';
      };
      const clamp = (v, min, max) => Math.max(min, Math.min(max, v | 0));

      // MQTT client
      let client = null;

      function sendPelCmd(obj) {
        const payload = JSON.stringify(obj);
        const topic = TOPIC.peltierCmdOf(currentRoom);
        console.log('MQTT PUB →', topic, payload);
        if (client && client.connected) {
          client.publish(topic, payload, { qos: 0, retain: false });
          setHdr('Đã gửi ' + payload + ' → ' + topic, 'ok');
        } else {
          setHdr('Chưa kết nối MQTT, không thể gửi', 'err');
        }
      }
      // ===== MASTER ENABLE (bật/tắt toàn bộ hệ thống theo phòng) =====
      const LS_SYS_ENABLE_PREFIX = 'room.sysEnable.v1.'; // per room
      const roomSysEnabled = { room1: true, room2: true, room3: true };

      function loadSysEnable(room) {
        const v = localStorage.getItem(LS_SYS_ENABLE_PREFIX + room);
        roomSysEnabled[room] = (v === null) ? true : (v === '1');
      }
      function saveSysEnable(room) {
        try { localStorage.setItem(LS_SYS_ENABLE_PREFIX + room, roomSysEnabled[room] ? '1' : '0'); } catch { }
      }
      ROOMS.forEach(loadSysEnable);

      // Gửi lệnh chung cho phòng (topic coldroom/{room}/client1)
      function sendRoomCmd(room, obj) {
        const payload = JSON.stringify(obj);
        const topic = TOPIC.pub(room);
        console.log('MQTT PUB →', topic, payload);
        if (client && client.connected) {
          client.publish(topic, payload, { qos: 1, retain: true });
          setHdr(`Đã gửi ${payload} → ${topic}`, 'ok');
        } else {
          setHdr('Chưa kết nối MQTT, không thể gửi', 'err');
        }
      }

      // ===== Cache nhiệt độ/độ ẩm  của 3 phòng =====
      const latestTH = {
        room1: { t: null, h: null, ts: 0 },
        room2: { t: null, h: null, ts: 0 },
        room3: { t: null, h: null, ts: 0 },
      };

      // ===== UI hiển thị 3 phòng =====
      const btnAllRooms = document.getElementById('btnAllRooms');
      const allRoomsWrap = document.getElementById('allRoomsWrap');

      const mini = {
        room1: { t: document.getElementById('mini_room1_t'), h: document.getElementById('mini_room1_h'), meta: document.getElementById('mini_room1_meta') },
        room2: { t: document.getElementById('mini_room2_t'), h: document.getElementById('mini_room2_h'), meta: document.getElementById('mini_room2_meta') },
        room3: { t: document.getElementById('mini_room3_t'), h: document.getElementById('mini_room3_h'), meta: document.getElementById('mini_room3_meta') },
      };

      const LS_ALLROOMS = 'room.allRooms.view';
      let allRoomsOn = (localStorage.getItem(LS_ALLROOMS) === '1');

      function fmtAge(ts) {
        if (!ts) return 'Chưa có dữ liệu';
        const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
        if (sec < 10) return 'Vừa cập nhật';
        if (sec < 60) return `Cập nhật ${sec}s trước`;
        const min = Math.floor(sec / 60);
        if (min < 60) return `Cập nhật ${min}p trước`;
        const hr = Math.floor(min / 60);
        return `Cập nhật ${hr}h trước`;
      }

      function renderAllRooms() {
        ROOMS.forEach(r => {
          const o = latestTH[r];
          if (!o) return;
          mini[r].t.textContent = Number.isFinite(o.t) ? Number(o.t).toFixed(1) : '--.-';
          mini[r].h.textContent = Number.isFinite(o.h) ? Number(o.h).toFixed(1) : '--.-';
          mini[r].meta.textContent = fmtAge(o.ts);
        });
      }

      function applyAllRoomsUI() {
        btnAllRooms.classList.toggle('active', allRoomsOn);
        allRoomsWrap.classList.toggle('hidden', !allRoomsOn);
        try { localStorage.setItem(LS_ALLROOMS, allRoomsOn ? '1' : '0'); } catch { }
        if (allRoomsOn) renderAllRooms();
      }

      btnAllRooms.addEventListener('click', () => {
        allRoomsOn = !allRoomsOn;
        applyAllRoomsUI();
      });
      applyAllRoomsUI();

      // ===== RFID MODULE =====
      const rfidModule = (function () {
        const tbodyToday = document.getElementById('rfidTbodyToday');
        const tbodyHistory = document.getElementById('rfidTbodyHistory');
        const cntEl = document.getElementById('rfidCnt');
        const search = document.getElementById('rfidSearch');
        const historyDaySel = document.getElementById('rfidHistoryDaySel');
        const subTodayBtn = document.getElementById('rfidSubTodayBtn');
        const subHistoryBtn = document.getElementById('rfidSubHistoryBtn');
        const paneToday = document.getElementById('rfidPaneToday');
        const paneHistory = document.getElementById('rfidPaneHistory');

        const statInStock = document.getElementById('rfidInStockCount');
        const statSafe = document.getElementById('rfidSafeCount');
        const statWatch = document.getElementById('rfidWatchCount');
        const statDanger = document.getElementById('rfidDangerCount');
        const statInToday = document.getElementById('rfidInToday');
        const statOutToday = document.getElementById('rfidOutToday');

        const statRoom1InStock = document.getElementById('rfidRoom1InStock');
        const statRoom2InStock = document.getElementById('rfidRoom2InStock');
        const statRoom3InStock = document.getElementById('rfidRoom3InStock');

        const hsdFilterChips = Array.from(document.querySelectorAll('.filterChip[data-hsd]'));
        const roomFilterChips = Array.from(document.querySelectorAll('.filterChip[data-room]'));
        const onlyInStockEl = document.getElementById('onlyInStock');

        const MAX_KEEP = 10000;
        document.getElementById('rfidMax').textContent = MAX_KEEP;

        let rows = [];
        const LS_RFID_ROWS = 'rfid.rows.v2';

        function saveRows() {
          try {
            const compact = rows.map(r => ({
              device_id: r.device_id, uid: r.uid, name: r.name, action: r.action,
              nsx: r.nsx, hsd: r.hsd,
              date: r.date, time: r.time, dayKey: r.dayKey,
              roomKey: r.roomKey, room: r.room,
              tmin: r.tmin, tmax: r.tmax, trange: r.trange,
              tsMillis: r.tsMillis,
              _frozenStaySec: r._frozenStaySec
            }));
            localStorage.setItem(LS_RFID_ROWS, JSON.stringify(compact));
          } catch (e) { console.warn('saveRows fail', e); }
        }

        function loadRows() {
          try {
            const s = localStorage.getItem(LS_RFID_ROWS);
            if (!s) return;
            const arr = JSON.parse(s);
            if (!Array.isArray(arr)) return;

            rows = arr.slice(0, MAX_KEEP).map(x => {
              const ex = computeExpireInfo(x.hsd);
              return {
                ...x,
                expire: ex.text,
                expireColor: ex.color,
                expireTextColor: ex.textColor,
                expireZone: ex.zone,
                expireDays: ex.days,
              };
            });

            deviceSet.clear();
            while (selDevice.options.length > 1) selDevice.remove(1);
            rows.forEach(r => addDeviceOpt(r.device_id));
          } catch (e) { console.warn('loadRows fail', e); }
        }

        let currentView = localStorage.getItem('rfid.currentView') || 'today';
        let currentHistoryDayKey = '';

        let currentHsdFilter = localStorage.getItem('rfid.hsdFilter') || 'all';
        let currentRoomFilter = localStorage.getItem('rfid.roomFilter') || 'all';
        const LS_ONLY_IN = 'rfid.onlyInStock';
        const LS_ROOM_FILTER = 'rfid.roomFilter';

        function todayKey() { return new Date().toISOString().slice(0, 10); }

        function setView(view) {
          currentView = (view === 'history') ? 'history' : 'today';
          try { localStorage.setItem('rfid.currentView', currentView); } catch { }
          subTodayBtn.classList.toggle('active', currentView === 'today');
          subHistoryBtn.classList.toggle('active', currentView === 'history');
          paneToday.classList.toggle('active', currentView === 'today');
          paneHistory.classList.toggle('active', currentView === 'history');
          render();
        }


        function normNoAccent(str) {
          return String(str || '')
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '');
        }

        function normalizeItemName(rawName) {
          if (!rawName) return '';
          const s = normNoAccent(rawName).trim();
          const map = {
            'ca chua': 'Cà chua',
            'ca tim': 'Cà tím',
            'dau cove': 'Đậu cove',
            'tac': 'Tắc',
            'trung': 'Trứng',
            'dua leo': 'Dưa leo',
            'thuoc vien': 'Thuốc viên',
            'thuoc bot': 'Thuốc bột',
            'my pham': 'Mỹ phẩm',
            'nuoc hoa': 'Nước hoa',
            'banh keo': 'Bánh kẹo',
            'ca phe': 'Cà phê',
            'gao': 'Gạo',
            'bot mi': 'Bột mì',
            'socola': 'Socola',
            'tra': 'Trà',
            'vitamin': 'Vitamin',
          };
          return map[s] || rawName;
        }

        function computeExpireInfo(hsdStr) {
          if (!hsdStr) return { text: '', color: '', textColor: '', zone: 'none', days: null };
          const s = String(hsdStr).trim();
          let d = null;
          let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
          if (m) d = new Date(parseInt(m[3], 10), parseInt(m[2], 10) - 1, parseInt(m[1], 10));
          else {
            m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
            if (m) d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
          }
          if (!d || isNaN(d)) return { text: '', color: '', textColor: '', zone: 'none', days: null };

          const now = new Date();
          const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          const hsd = new Date(d.getFullYear(), d.getMonth(), d.getDate());
          const diffDays = Math.floor((hsd - today) / (1000 * 60 * 60 * 24));

          if (diffDays >= 14) return { text: `Còn ${diffDays} ngày`, color: '#16a34a', textColor: '#ffffff', zone: 'safe', days: diffDays };
          if (diffDays >= 7) return { text: `Còn ${diffDays} ngày`, color: '#f59e0b', textColor: '#111827', zone: 'watch', days: diffDays };
          if (diffDays > 0) return { text: `Còn ${diffDays} ngày`, color: '#ef4444', textColor: '#ffffff', zone: 'danger', days: diffDays };
          if (diffDays === 0) return { text: 'Hết hạn hôm nay', color: '#ef4444', textColor: '#ffffff', zone: 'danger', days: diffDays };
          return { text: `Quá hạn ${Math.abs(diffDays)} ngày`, color: '#b91c1c', textColor: '#ffffff', zone: 'danger', days: diffDays };
        }

        let liveTimer = null;

        function fmtDuration(sec) {
          sec = Math.max(0, Math.floor(sec || 0));
          const d = Math.floor(sec / 86400); sec %= 86400;
          const h = Math.floor(sec / 3600); sec %= 3600;
          const m = Math.floor(sec / 60);
          const s = sec % 60;

          if (d > 0) return `${d} ngày ${h} giờ`;
          if (h > 0) return `${h} giờ ${m} phút`;
          if (m > 0) return `${m} phút ${s} giây`;
          return `${s} giây`;
        }

        function roomKeyFromPayload(raw) {
          const r1 = String(raw.room ?? raw.Room ?? '').toLowerCase().trim();
          if (['room1', 'room2', 'room3'].includes(r1)) return r1;

          const p = raw.phong ?? raw.Phong ?? raw.roomNo ?? raw.room_no ?? null;
          const n = Number(p);
          if (n === 1) return 'room1';
          if (n === 2) return 'room2';
          if (n === 3) return 'room3';
          return '';
        }

        function roomDisplay(roomKey) {
          if (roomKey === 'room1') return 'Phòng 1';
          if (roomKey === 'room2') return 'Phòng 2';
          if (roomKey === 'room3') return 'Phòng 3';
          return '—';
        }

        function parseTemp(v) {
          if (v === null || v === undefined) return null;
          const n = Number(v);
          return Number.isFinite(n) ? n : null;
        }

        function normalizeRow(raw) {
          if (!raw || typeof raw !== 'object') return null;

          const ts = raw.timestamp || raw.time || new Date().toISOString();
          const parts = String(ts).split(/[ T]/);
          let dateIso = parts[0] || todayKey();
          let timeStr = (parts[1] || '').slice(0, 8);

          let dateText = dateIso;
          const mm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateIso);
          if (mm) dateText = `${mm[3]}/${mm[2]}/${mm[1]}`;

          const hsd = raw.hsd || raw.HSD || '';
          const nsx = raw.nsx || raw.NSX || '';
          const ex = computeExpireInfo(hsd);

          const rawName = raw.name || '';
          const itemName = normalizeItemName(rawName);

          const rKey = roomKeyFromPayload(raw) || 'unknown';

          const tmin = parseTemp(raw.tmin ?? raw.TMIN ?? raw.tempMin ?? raw.temp_min);
          const tmax = parseTemp(raw.tmax ?? raw.TMAX ?? raw.tempMax ?? raw.temp_max);
          const trange = (tmin !== null && tmax !== null) ? `${tmin}–${tmax}°C` : '';

          let tsMillis = Date.parse(ts);
          if (!Number.isFinite(tsMillis)) {
            const tt = timeStr || '00:00:00';
            tsMillis = Date.parse(`${dateIso}T${tt}`);
          }
          if (!Number.isFinite(tsMillis)) tsMillis = Date.now();

          return {
            tsMillis,
            _frozenStaySec: raw._frozenStaySec ?? null,
            device_id: raw.device_id || '',
            uid: String(raw.uid || '').toUpperCase(),
            name: itemName,
            action: String(raw.action || '').toUpperCase(),
            nsx, hsd,
            expire: ex.text,
            expireColor: ex.color,
            expireTextColor: ex.textColor,
            expireZone: ex.zone,
            expireDays: ex.days,
            date: dateText,
            time: timeStr,
            dayKey: dateIso,
            roomKey: rKey,
            room: roomDisplay(rKey),
            tmin, tmax, trange
          };
        }

        function matchesFilter(it, index, stockIndex) {

          const qRaw = search.value.trim();
          if (qRaw) {
            const q = normNoAccent(qRaw);
            const uidStr = String(it.uid || '').toLowerCase();
            const nameNorm = normNoAccent(it.name);
            if (!uidStr.includes(q) && !nameNorm.includes(q)) return false;
          }

          if (currentHsdFilter && currentHsdFilter !== 'all') {
            if (it.expireZone !== currentHsdFilter) return false;
          }

          if (currentRoomFilter && currentRoomFilter !== 'all') {
            if (it.roomKey !== currentRoomFilter) return false;
          }

          if (onlyInStockEl && onlyInStockEl.checked) {
            if (!it.uid) return false;
            const info = stockIndex[it.uid];
            if (!info || info.lastAction !== 'IN' || info.lastInRow !== index) return false;
          }

          return true;
        }

        function ensureHistoryDaySel() {
          const tKey = todayKey();
          const daySet = new Set(rows.map(r => r.dayKey));
          const all = Array.from(daySet);
          const historyKeys = all.filter(k => k !== tKey).sort().reverse();
          historyDaySel.innerHTML = '';
          if (!historyKeys.length) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = '(Chưa có lịch sử)';
            historyDaySel.appendChild(opt);
            currentHistoryDayKey = '';
            return;
          }
          if (!currentHistoryDayKey || !historyKeys.includes(currentHistoryDayKey)) {
            currentHistoryDayKey = historyKeys[0];
          }
          historyKeys.forEach(k => {
            const opt = document.createElement('option');
            opt.value = k;
            const [y, m, d] = k.split('-');
            opt.textContent = `${d}/${m}/${y}`;
            if (k === currentHistoryDayKey) opt.selected = true;
            historyDaySel.appendChild(opt);
          });
        }

        function buildRow(it, stt) {
          const tr = document.createElement('tr');
          const badge = it.action === 'IN'
            ? '<span class="badge b-in">IN</span>'
            : '<span class="badge b-out">OUT</span>';

          const styleExpire = [];
          if (it.expireColor) styleExpire.push(`background:${it.expireColor}`);
          if (it.expireTextColor) styleExpire.push(`color:${it.expireTextColor}`);
          const styleStr = styleExpire.length ? ` style="${styleExpire.join(';')}"` : '';

          const frozenText = (it._frozenStaySec != null) ? fmtDuration(it._frozenStaySec) : '';

          tr.innerHTML = `
            <td class="mono">${stt}</td>
            <td>${it.name || ''}</td>
            <td><b>${it.room || ''}</b></td>
            <td class="mono"><b>${it.trange || ''}</b></td>
            <td>${badge}</td>
            <td class="mono">${it.date || ''}</td>
            <td class="mono">${it.time || ''}</td>
            <td class="mono">${it.nsx || ''}</td>
            <td class="mono">${it.hsd || ''}</td>
            <td class="mono stayCell"
                data-uid="${it.uid || ''}"
                data-start="${it.tsMillis || 0}"
                data-live="0">${frozenText}</td>
            <td class="mono expireCell"${styleStr}>${it.expire || ''}</td>
          `;
          return tr;
        }

        function computeFrozenStays() {
          const lastInByUid = {};
          for (let i = rows.length - 1; i >= 0; i--) {
            const r = rows[i];
            if (!r.uid) continue;

            if (r.action === 'IN') {
              lastInByUid[r.uid] = { tsMillis: r.tsMillis, rowIndex: i };
            } else if (r.action === 'OUT') {
              const inInfo = lastInByUid[r.uid];
              if (inInfo) {
                const dur = Math.max(0, Math.floor((r.tsMillis - inInfo.tsMillis) / 1000));
                r._frozenStaySec = dur;
                rows[inInfo.rowIndex]._frozenStaySec = dur;
                delete lastInByUid[r.uid];
              }
            }
          }
        }

        function render() {
          cntEl.textContent = rows.length;
          ensureHistoryDaySel();
          tbodyToday.innerHTML = '';
          tbodyHistory.innerHTML = '';

          const tKey = todayKey();
          computeFrozenStays();

          const stockIndex = {};
          for (let i = 0; i < rows.length; i++) {
            const r = rows[i];
            if (!r.uid) continue;
            const u = r.uid;
            if (!stockIndex[u]) stockIndex[u] = { lastAction: r.action, lastInRow: null };
            if (r.action === 'IN' && stockIndex[u].lastInRow === null) stockIndex[u].lastInRow = i;
          }

          let inToday = 0, outToday = 0;
          for (const r of rows) {
            if (r.dayKey === tKey) {
              if (r.action === 'IN') inToday++;
              else if (r.action === 'OUT') outToday++;
            }
          }

          let inStockCount = 0, safeCount = 0, watchCount = 0, dangerCount = 0;
          let room1Count = 0, room2Count = 0, room3Count = 0;

          Object.keys(stockIndex).forEach(uid => {
            const info = stockIndex[uid];
            if (info.lastAction === 'IN' && info.lastInRow != null) {
              const r = rows[info.lastInRow];
              inStockCount++;
              if (r.expireZone === 'safe') safeCount++;
              else if (r.expireZone === 'watch') watchCount++;
              else if (r.expireZone === 'danger') dangerCount++;

              if (r.roomKey === 'room1') room1Count++;
              else if (r.roomKey === 'room2') room2Count++;
              else if (r.roomKey === 'room3') room3Count++;
            }
          });

          statInStock.textContent = inStockCount;
          statSafe.textContent = safeCount;
          statWatch.textContent = watchCount;
          statDanger.textContent = dangerCount;
          statInToday.textContent = inToday;
          statOutToday.textContent = outToday;

          statRoom1InStock.textContent = room1Count;
          statRoom2InStock.textContent = room2Count;
          statRoom3InStock.textContent = room3Count;

          let sttToday = 1, sttHistory = 1;
          for (let i = 0; i < rows.length; i++) {
            const it = rows[i];
            if (it.dayKey === tKey && matchesFilter(it, i, stockIndex)) tbodyToday.appendChild(buildRow(it, sttToday++));
            if (currentHistoryDayKey && it.dayKey === currentHistoryDayKey && matchesFilter(it, i, stockIndex))
              tbodyHistory.appendChild(buildRow(it, sttHistory++));
          }

          // live stay timer
          if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }

          function updateLiveCells() {
            const now = Date.now();
            const cells = document.querySelectorAll('.stayCell[data-live="1"]');
            cells.forEach(td => {
              const start = Number(td.dataset.start || 0);
              if (!start) return;
              const sec = Math.floor((now - start) / 1000);
              td.textContent = fmtDuration(sec);
            });
          }

          document.querySelectorAll('.stayCell').forEach(td => td.dataset.live = "0");

          Object.keys(stockIndex).forEach(uid => {
            const info = stockIndex[uid];
            if (info && info.lastAction === 'IN' && info.lastInRow != null) {
              const inRow = rows[info.lastInRow];
              const sel = `.stayCell[data-uid="${uid}"][data-start="${inRow.tsMillis}"]`;
              const td = document.querySelector(sel);
              if (td) {
                td.dataset.live = "1";
                td.textContent = fmtDuration((Date.now() - inRow.tsMillis) / 1000);
              }
            }
          });

          document.querySelectorAll('.stayCell[data-live="0"]').forEach(td => {
            const uid = td.dataset.uid;
            const start = Number(td.dataset.start || 0);
            const r = rows.find(x => x.uid === uid && x.tsMillis === start);
            if (r && r._frozenStaySec != null) td.textContent = fmtDuration(r._frozenStaySec);
          });

          liveTimer = setInterval(updateLiveCells, 1000);
        }

        function handleRFIDMessage(payload) {
          try {
            const msg = JSON.parse(payload);
            const it = normalizeRow(msg);
            if (!it || !it.uid) return;

            if (it.roomKey === 'unknown') setHdr('RFID thiếu trường room (room1/2/3) → không phân loại được!', 'warn');

            rows.unshift(it);
            if (rows.length > MAX_KEEP) rows.length = MAX_KEEP;
            render();
            saveRows();
          } catch (e) { console.warn('RFID JSON error', e); }
        }

        document.getElementById('btnRFIDClear').addEventListener('click', () => {
          while (selDevice.options.length > 1) selDevice.remove(1);
          render();
          try { localStorage.removeItem(LS_RFID_ROWS); } catch (e) { }
          setHdr('Đã xoá toàn bộ bảng RFID', 'warn');
        });

        document.getElementById('btnRFIDClearScreen').addEventListener('click', () => {
          if (currentView === 'today') tbodyToday.innerHTML = ''; else tbodyHistory.innerHTML = '';
        });

        document.getElementById('btnRFIDRestore').addEventListener('click', render);

        document.getElementById('btnRFIDCSV').addEventListener('click', () => {
          const hdr = ['stt', 'name', 'room', 'temp_range', 'io', 'date', 'time', 'nsx', 'hsd', 'stay', 'expire'];
          const csv = [hdr.join(',')].concat(rows.map((r, idx) => {
            const stay = (r._frozenStaySec != null) ? fmtDuration(r._frozenStaySec) : '';
            const m = {
              stt: idx + 1,
              name: r.name || '',
              room: r.room || '',
              temp_range: r.trange || '',
              io: r.action || '',
              date: r.date || '',
              time: r.time || '',
              nsx: r.nsx || '',
              hsd: r.hsd || '',
              stay,
              expire: r.expire || ''
            };
            return hdr.map(k => '"' + String(m[k]).replace(/"/g, '""') + '"').join(',');
          })).join('\n');
          const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'rfid-log.csv';
          a.click();
          URL.revokeObjectURL(a.href);
        });

        search.addEventListener('input', debounce(render, 160));
        subTodayBtn.addEventListener('click', () => setView('today'));
        subHistoryBtn.addEventListener('click', () => setView('history'));
        historyDaySel.addEventListener('change', () => { currentHistoryDayKey = historyDaySel.value || ''; render(); });

        function applyHsdFilterUI() { hsdFilterChips.forEach(btn => btn.classList.toggle('active', btn.dataset.hsd === currentHsdFilter)); render(); }
        function applyRoomFilterUI() { roomFilterChips.forEach(btn => btn.classList.toggle('active', btn.dataset.room === currentRoomFilter)); render(); }

        if (onlyInStockEl) {
          const saved = localStorage.getItem(LS_ONLY_IN);
          if (saved === '1') onlyInStockEl.checked = true;
          onlyInStockEl.addEventListener('change', () => {
            try { localStorage.setItem(LS_ONLY_IN, onlyInStockEl.checked ? '1' : '0'); } catch { }
            render();
          });
        }

        if (hsdFilterChips.length) {
          hsdFilterChips.forEach(btn => btn.addEventListener('click', () => {
            currentHsdFilter = btn.dataset.hsd || 'all';
            try { localStorage.setItem('rfid.hsdFilter', currentHsdFilter); } catch { }
            applyHsdFilterUI();
          }));
          if (!['all', 'safe', 'watch', 'danger'].includes(currentHsdFilter)) currentHsdFilter = 'all';
        }

        if (roomFilterChips.length) {
          if (!['all', 'room1', 'room2', 'room3'].includes(currentRoomFilter)) currentRoomFilter = 'all';
          roomFilterChips.forEach(btn => btn.addEventListener('click', () => {
            currentRoomFilter = btn.dataset.room || 'all';
            try { localStorage.setItem(LS_ROOM_FILTER, currentRoomFilter); } catch { }
            applyRoomFilterUI();
          }));
        }

        loadRows();
        setView(currentView);
        applyHsdFilterUI();
        applyRoomFilterUI();

        return { handleRFIDMessage };
      })();

      // ===== ROOM MODULE =====
      const roomMod = (function () {
        const tbody = document.getElementById('roomTbody');

        const doorBadge = document.getElementById('doorBadge');
        const doorText = document.getElementById('doorText');

        const alarmBadge = document.getElementById('alarmBadge');
        const alarmText = document.getElementById('alarmText');
        const alarmDot = document.getElementById('alarmDot');
        const alarmLED = document.getElementById('alarmLED');

        const chkDoorMarkers = document.getElementById('chkDoorMarkers');
        const chkAlarmOnMarkers = document.getElementById('chkAlarmOnMarkers');
        const chkAlarmOffMarkers = document.getElementById('chkAlarmOffMarkers');

        const roomSysEnableEl = document.getElementById('roomSysEnable');

        const alarmEnableWebEl = document.getElementById('alarmEnableWeb');
        const LS_ALARM_WEB_PREFIX = 'room.alarmWeb.enable.v1.';
        const alarmWebEnable = { room1: true, room2: true, room3: true };

        function loadAlarmWebEnable(room) {
          const v = localStorage.getItem(LS_ALARM_WEB_PREFIX + room);
          alarmWebEnable[room] = (v === null) ? true : (v === '1');
        }
        function saveAlarmWebEnable(room) { localStorage.setItem(LS_ALARM_WEB_PREFIX + room, alarmWebEnable[room] ? '1' : '0'); }
        ['room1', 'room2', 'room3'].forEach(loadAlarmWebEnable);
        function isAlarmWebEnabled(room) { return !!alarmWebEnable[room]; }
        function isSysEnabled(room) {
          return !!roomSysEnabled[room];
        }

        function applySysEnableUI(room) {
          if (!roomSysEnableEl) return;

          // set checkbox theo phòng
          roomSysEnableEl.checked = isSysEnabled(room);

          const enabled = isSysEnabled(room);

          // Khoá/mở toàn bộ điều khiển ở web
          const toDisable = [
            document.getElementById('peltierEnable'),
            document.getElementById('modeAuto'),
            document.getElementById('modeManual'),
            document.getElementById('modeOff'),
            document.getElementById('peltierSlider'),
            document.getElementById('autoSetpoint'),
            document.getElementById('autoBoostBand'),
            document.getElementById('autoHys'),
            document.getElementById('autoMinDuty'),
            document.getElementById('autoMaxDuty'),
            document.getElementById('autoApplyBtn'),
            document.getElementById('rangeLowInput'),
            document.getElementById('rangeHighInput'),
            document.getElementById('bandSaveBtn'),
            document.getElementById('bandDefaultBtn'),
            document.getElementById('alarmEnableWeb'),
            document.getElementById('btnOpenTHLog'),
          ].filter(Boolean);

          toDisable.forEach(el => el.disabled = !enabled);

          // Nếu OFF: ẩn badge alarm + LED
          if (!enabled) {
            alarmBadge.classList.add('hidden');
            alarmLED.classList.add('hidden');
            alarmLED.classList.remove('red', 'pulse');
            alarmText.textContent = 'ALARM: —';
          }
        }

        // Khi bấm bật/tắt hệ thống phòng
        if (roomSysEnableEl) {
          roomSysEnableEl.addEventListener('change', () => {
            const en = !!roomSysEnableEl.checked;
            roomSysEnabled[currentRoom] = en;
            saveSysEnable(currentRoom);

            applySysEnableUI(currentRoom);

            // Gửi lệnh master enable xuống ESP32
            sendRoomCmd(currentRoom, { systemEnable: en ? 1 : 0 });

            if (!en) {
              try {
                sendPelCmd({ mode: 'off', enable: 0 });
                sendPelCmd({ alarmEnable: 0 });
              } catch { }
              setHdr('Đã TẮT toàn bộ hệ thống cho ' + currentRoom, 'warn');
            } else {
              setHdr('Đã BẬT hệ thống cho ' + currentRoom, 'ok');
              // có thể yêu cầu ESP trả state lại
              try { sendRoomCmd(currentRoom, { getState: 1 }); } catch { }
            }
          });
        }

        function applyAlarmWebUI(room) {
          if (!alarmEnableWebEl) return;
          alarmEnableWebEl.checked = isAlarmWebEnabled(room);
          if (!isAlarmWebEnabled(room) && room === currentRoom) {
            alarmBadge.classList.add('hidden');
            alarmLED.classList.add('hidden');
            alarmLED.classList.remove('red', 'pulse');
            alarmText.textContent = 'ALARM: —';
          }
        }

        // ===== NGƯỠNG / AUTO UI =====
        const rangeLowInput = document.getElementById('rangeLowInput');
        const rangeHighInput = document.getElementById('rangeHighInput');
        const bandSaveBtn = document.getElementById('bandSaveBtn');
        const bandDefaultBtn = document.getElementById('bandDefaultBtn');
        const bandExplain = document.getElementById('bandExplain');

        const autoSetpoint = document.getElementById('autoSetpoint');
        const autoBoostBand = document.getElementById('autoBoostBand');
        const autoHys = document.getElementById('autoHys');
        const autoMinDuty = document.getElementById('autoMinDuty');
        const autoMaxDuty = document.getElementById('autoMaxDuty');
        const autoApplyBtn = document.getElementById('autoApplyBtn');
        const autoExplain = document.getElementById('autoExplain');

        const autoEdit = { sp: false, boost: false, hys: false, min: false, max: false };
        const autoDirty = { sp: false, boost: false, hys: false, min: false, max: false };

        function bindAutoGuard(el, key) {
          if (!el) return;
          el.addEventListener('focus', () => autoEdit[key] = true);
          el.addEventListener('blur', () => autoEdit[key] = false);
          el.addEventListener('input', () => autoDirty[key] = true);
        }
        bindAutoGuard(autoSetpoint, 'sp');
        bindAutoGuard(autoBoostBand, 'boost');
        bindAutoGuard(autoHys, 'hys');
        bindAutoGuard(autoMinDuty, 'min');
        bindAutoGuard(autoMaxDuty, 'max');

        function safeSetAutoInput(key, el, valueStr) {
          if (!el) return;
          if (autoEdit[key]) return;
          if (autoDirty[key]) return;
          el.value = valueStr;
        }

        // ===== HISTORY (localStorage theo phòng) =====
        const STORAGE_MAX = 100000;
        const VIEW_MAX_POINTS = 1000;     
        const VIEW_MS = 24 * 60 * 60 * 1000; 
        const LS_HRAW_PREFIX = 'roomTH.raw.v3.';
        const histRaw = { room1: [], room2: [], room3: [] };

        function loadRaw(room) {
          try {
            const s = localStorage.getItem(LS_HRAW_PREFIX + room);
            const arr = JSON.parse(s || '[]');
            histRaw[room] = Array.isArray(arr) ? arr : [];
          } catch { histRaw[room] = []; }
        }
        ['room1', 'room2', 'room3'].forEach(loadRaw);

        const saveRawDebounced = {};
        function saveRaw(room) {
          try { localStorage.setItem(LS_HRAW_PREFIX + room, JSON.stringify(histRaw[room] || [])); } catch (e) { }
        }
        function scheduleSaveRaw(room) {
          if (!saveRawDebounced[room]) saveRawDebounced[room] = debounce(() => saveRaw(room), 800);
          saveRawDebounced[room]();
        }

        function pushRaw(room, rec) {
          const a = histRaw[room];
          a.push(rec);
          if (a.length > STORAGE_MAX) a.splice(0, a.length - STORAGE_MAX);
          scheduleSaveRaw(room);
        }

        function timeLabel(ts) {
          return new Date(ts).toLocaleTimeString('vi-VN', { hour12: false });
        }

        function buildViewSeries(room) {
          const now = Date.now();
          const from = now - VIEW_MS;

          const raw = histRaw[room] || [];

          const tele = [];
          const doorEv = [];
          const alarmOnEv = [];
          const alarmOffEv = [];

          for (let i = 0; i < raw.length; i++) {
            const r = raw[i];
            const ts = r[0];
            if (!ts || ts < from) continue;
            const ev = r[6] || 0;
            if (ev === 0) tele.push(r);
            else if (ev === 1) doorEv.push(r);
            else if (ev === 2) alarmOnEv.push(r);
            else if (ev === 3) alarmOffEv.push(r);
          }

          let sampled = tele;
          if (tele.length > VIEW_MAX_POINTS) {
            const step = Math.ceil(tele.length / VIEW_MAX_POINTS);
            sampled = [];
            for (let i = 0; i < tele.length; i += step) sampled.push(tele[i]);
          }

          const labels = sampled.map(r => timeLabel(r[0]));
          const t = sampled.map(r => Number(r[1]));
          const h = sampled.map(r => Number(r[2]));

          const sampledTs = sampled.map(r => r[0]);
          function nearestLabel(ts) {
            if (!sampledTs.length) return null;

            let lo = 0, hi = sampledTs.length - 1;
            while (lo < hi) {
              const mid = (lo + hi) >> 1;
              if (sampledTs[mid] < ts) lo = mid + 1; else hi = mid;
            }
            let idx = lo;
            if (idx > 0) {
              const a = Math.abs(sampledTs[idx] - ts);
              const b = Math.abs(sampledTs[idx - 1] - ts);
              if (b <= a) idx = idx - 1;
            }
            return { label: labels[idx], y: Number(sampled[idx][1]) };
          }

          const doorOpenPts = [];
          const doorClosedPts = [];
          if (chkDoorMarkers?.checked) {
            for (const r of doorEv) {
              const door = Number(r[3]) === 1 ? 1 : 0;
              const nl = nearestLabel(r[0]);
              if (!nl) continue;
              if (door === 1) doorOpenPts.push({ x: nl.label, y: nl.y });
              else doorClosedPts.push({ x: nl.label, y: nl.y });
            }
          }

          const alarmOnPts = [];
          if (chkAlarmOnMarkers?.checked) {
            for (const r of alarmOnEv) {
              const nl = nearestLabel(r[0]);
              if (!nl) continue;
              alarmOnPts.push({ x: nl.label, y: nl.y });
            }
          }

          const alarmOffPts = [];
          if (chkAlarmOffMarkers?.checked) {
            for (const r of alarmOffEv) {
              const nl = nearestLabel(r[0]);
              if (!nl) continue;
              alarmOffPts.push({ x: nl.label, y: nl.y });
            }
          }

          return { labels, t, h, doorOpenPts, doorClosedPts, alarmOnPts, alarmOffPts };
        }

        // ===== Chart =====
        const ctx = document.getElementById('thChart').getContext('2d');
        const chart = new Chart(ctx, {
          type: 'line',
          data: {
            labels: [],
            datasets: [
              // 0 temp
              { label: 'Nhiệt độ (°C)', data: [], tension: .25, pointRadius: 0, borderWidth: 2, borderColor: 'rgba(239,68,68,0.95)', backgroundColor: 'rgba(239,68,68,0.12)' },
              // 1 humi
              { label: 'Độ ẩm (%RH)', data: [], tension: .25, pointRadius: 0, borderWidth: 2, borderColor: 'rgba(37,99,235,0.95)', backgroundColor: 'rgba(37,99,235,0.10)' },
              // 2 LOW
              { label: 'Ngưỡng thấp', data: [], tension: 0, pointRadius: 0, borderDash: [6, 4], borderWidth: 1.3, borderColor: 'rgba(16,185,129,0.85)' },
              // 3 HIGH
              { label: 'Ngưỡng cao', data: [], tension: 0, pointRadius: 0, borderDash: [6, 4], borderWidth: 1.3, borderColor: 'rgba(16,185,129,0.85)' },
              // 4 ALARM ON marker
              {
                type: 'scatter',
                label: 'Cảnh báo bật',
                data: [],
                showLine: false,
                pointRadius: 6,
                pointHoverRadius: 7,
                borderWidth: 2,
                borderColor: 'rgba(239,68,68,0.95)',
                backgroundColor: 'rgba(239,68,68,0.25)'
              },
              // 5 ALARM OFF/CLEAR marker
              {
                type: 'scatter',
                label: 'Cảnh báo tắt',
                data: [],
                showLine: false,
                pointRadius: 6,
                pointHoverRadius: 7,
                borderWidth: 2,
                borderColor: 'rgba(34,197,94,0.95)',
                backgroundColor: 'rgba(34,197,94,0.22)'
              },
              // 6 DOOR OPEN marker
              {
                type: 'scatter',
                label: 'Cửa mở',
                data: [],
                showLine: false,
                pointRadius: 5,
                pointHoverRadius: 6,
                borderWidth: 2,
                borderColor: 'rgba(245,158,11,0.95)',
                backgroundColor: 'rgba(245,158,11,0.22)'
              },
              // 7 DOOR CLOSED marker
              {
                type: 'scatter',
                label: 'Cửa đóng',
                data: [],
                showLine: false,
                pointRadius: 5,
                pointHoverRadius: 6,
                borderWidth: 2,
                borderColor: 'rgba(16,185,129,0.95)',
                backgroundColor: 'rgba(16,185,129,0.20)'
              },
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'nearest', intersect: false },
            plugins: {
              legend: { labels: { color: getComputedStyle(document.documentElement).getPropertyValue('--text') } }
            },
            scales: {
              x: {
                ticks: {
                  display: false,             
                  autoSkip: true,
                  maxRotation: 0,
                  color: getComputedStyle(document.documentElement).getPropertyValue('--muted')
                },
                grid: { color: 'rgba(148,163,184,.15)' }, 
                border: { display: false }                
              },
              y: {
                ticks: { color: getComputedStyle(document.documentElement).getPropertyValue('--muted') },
                grid: { color: 'rgba(148,163,184,.12)' }
              }
            }

          }
        });

        // ===== TH Modal (theo từng phòng) =====
        const thOverlay = document.getElementById('thModalOverlay');
        const btnOpenTHLog = document.getElementById('btnOpenTHLog');
        const btnCloseTHModal = document.getElementById('btnCloseTHModal');
        const thLogTbody = document.getElementById('thLogTbody');
        const thLogCount = document.getElementById('thLogCount');
        const thLogEnable = document.getElementById('thLogEnable');
        const thLogLimit = document.getElementById('thLogLimit');
        const thLogSearch = document.getElementById('thLogSearch');
        const thLogRoomLbl = document.getElementById('thLogRoomLbl');
        const btnTHExportCSV = document.getElementById('btnTHExportCSV');
        const btnTHClear = document.getElementById('btnTHClear');

        const LS_TH_ENABLE = 'roomTH.table.enable';
        const LS_TH_LIMIT = 'roomTH.table.limit';
        const LS_TH_TABLE_PREFIX = 'roomTH.table.v2.';

        let thTable = { room1: [], room2: [], room3: [] };

        function roomKeyForTable(room) { return LS_TH_TABLE_PREFIX + room; }

        function loadTHTable() {
          const en = localStorage.getItem(LS_TH_ENABLE);
          thLogEnable.checked = (en !== '0');

          const lim = Number(localStorage.getItem(LS_TH_LIMIT));
          thLogLimit.value = String((Number.isFinite(lim) && lim >= 100) ? lim : 10000);

          ['room1', 'room2', 'room3'].forEach(r => {
            try {
              const s = localStorage.getItem(roomKeyForTable(r));
              const arr = JSON.parse(s || '[]');
              thTable[r] = Array.isArray(arr) ? arr : [];
            } catch { thTable[r] = []; }
          });
        }

        function saveTHTable(room) {
          try { localStorage.setItem(roomKeyForTable(room), JSON.stringify(thTable[room] || [])); } catch { }
        }

        function openTHModal() {
          thOverlay.classList.add('active');
          thOverlay.setAttribute('aria-hidden', 'false');
          renderTHTable();
        }
        function closeTHModal() {
          thOverlay.classList.remove('active');
          thOverlay.setAttribute('aria-hidden', 'true');
        }

        btnOpenTHLog.addEventListener('click', openTHModal);
        btnCloseTHModal.addEventListener('click', closeTHModal);
        thOverlay.addEventListener('click', (e) => { if (e.target === thOverlay) closeTHModal(); });
        window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeTHModal(); });

        thLogEnable.addEventListener('change', () => {
          localStorage.setItem(LS_TH_ENABLE, thLogEnable.checked ? '1' : '0');
          setHdr(thLogEnable.checked ? 'Đã bật ghi log T/H' : 'Đã tắt ghi log T/H', 'ok');
        });

        thLogLimit.addEventListener('change', () => {
          let lim = Number(thLogLimit.value);
          if (!Number.isFinite(lim) || lim < 100) lim = 100;
          if (lim > 10000) lim = 10000;
          thLogLimit.value = String(lim);
          localStorage.setItem(LS_TH_LIMIT, String(lim));

          // cắt theo phòng
          ['room1', 'room2', 'room3'].forEach(r => {
            if ((thTable[r] || []).length > lim) {
              thTable[r] = thTable[r].slice(0, lim);
              saveTHTable(r);
            }
          });
          renderTHTable();
        });

        const renderTHTable = debounce(() => {
          if (thLogRoomLbl) thLogRoomLbl.textContent = currentRoom;

          const q = (thLogSearch.value || '').trim().toLowerCase();
          let view = thTable[currentRoom] || [];
          if (q) view = view.filter(x => (x.iso || '').toLowerCase().includes(q) || (x.note || '').toLowerCase().includes(q));

          thLogCount.textContent = String(view.length);
          thLogTbody.innerHTML = '';

          view.forEach(r => {
            const doorTxt = (r.door === 1) ? 'OPEN' : 'CLOSED';
            const alarmTxt = (r.alarmTemp === 1)
              ? ((r.alarmDir < 0) ? 'ON (QUÁ THẤP)' : (r.alarmDir > 0) ? 'ON (QUÁ CAO)' : 'ON')
              : 'OFF';

            const tr = document.createElement('tr');
            tr.innerHTML = `
              <td class="mono">${r.iso || ''}</td>
              <td class="mono">${r.room || ''}</td>
              <td class="mono"><b>${Number(r.t).toFixed(1)}</b></td>
              <td class="mono"><b>${Number(r.h).toFixed(1)}</b></td>
              <td class="mono"><b>${doorTxt}</b></td>
              <td class="mono"><b>${alarmTxt}</b></td>
              <td>${r.note || ''}</td>
            `;
            thLogTbody.appendChild(tr);
          });
        }, 80);

        thLogSearch.addEventListener('input', renderTHTable);

        btnTHClear.addEventListener('click', () => {
          thTable[currentRoom] = [];
          try { localStorage.removeItem(roomKeyForTable(currentRoom)); } catch { }
          renderTHTable();
          setHdr('Đã xoá log T/H của ' + currentRoom, 'warn');
        });

        btnTHExportCSV.addEventListener('click', () => {
          const hdr = ['timestamp_iso', 'room', 'temp_c', 'humi_rh', 'door', 'alarm', 'alarm_dir', 'note'];
          const arr = thTable[currentRoom] || [];

          const csv = [hdr.join(',')].concat(arr.map(r => {
            const row = {
              timestamp_iso: r.iso || '',
              room: r.room || '',
              temp_c: Number(r.t).toFixed(1),
              humi_rh: Number(r.h).toFixed(1),
              door: (r.door === 1) ? 'OPEN' : 'CLOSED',
              alarm: (r.alarmTemp === 1) ? 'ON' : 'OFF',
              alarm_dir: Number(r.alarmDir || 0),
              note: r.note || ''
            };
            return hdr.map(k => '"' + String(row[k]).replace(/"/g, '""') + '"').join(',');
          })).join('\n');

          const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `room-th-log-${currentRoom}.csv`;
          a.click();
          URL.revokeObjectURL(a.href);
        });

        function pushTHLog(room, t, h, note = '') {
          if (!thLogEnable.checked) return;

          const lim = Number(localStorage.getItem(LS_TH_LIMIT)) || Number(thLogLimit.value) || 10000;
          const now = new Date();
          const iso = now.toLocaleString('vi-VN', {
            timeZone: 'Asia/Ho_Chi_Minh',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
          }).replace(',', '');

          const st = stateCache[room] || {};
          const entry = {
            ts: Date.now(),
            iso,
            room,
            t: Number(t),
            h: Number(h),
            door: (st.door === 1) ? 1 : 0,
            alarmTemp: (st.alarmTemp === 1) ? 1 : 0,
            alarmDir: Number(st.alarmDir || 0),
            note: note || ''
          };

          if (!thTable[room]) thTable[room] = [];
          thTable[room].unshift(entry);
          if (thTable[room].length > lim) thTable[room].length = lim;
          saveTHTable(room);

          if (thOverlay.classList.contains('active')) renderTHTable();
        }

        // ===== Peltier cache + state cache =====
        const pelCache = { room1: null, room2: null, room3: null };
        const stateCache = {
          room1: { door: null, alarmTemp: null, alarmDir: 0, alarmEnable: null, lastT: null, lastH: null },
          room2: { door: null, alarmTemp: null, alarmDir: 0, alarmEnable: null, lastT: null, lastH: null },
          room3: { door: null, alarmTemp: null, alarmDir: 0, alarmEnable: null, lastT: null, lastH: null },
        };

        if (alarmEnableWebEl) {
          alarmEnableWebEl.addEventListener('change', () => {
            alarmWebEnable[currentRoom] = !!alarmEnableWebEl.checked;
            saveAlarmWebEnable(currentRoom);

            sendPelCmd({ alarmEnable: alarmEnableWebEl.checked ? 1 : 0 });

            if (!alarmEnableWebEl.checked) {
              alarmBadge.classList.add('hidden');
              alarmLED.classList.add('hidden');
              alarmLED.classList.remove('red', 'pulse');
              alarmText.textContent = 'ALARM: —';
              setHdr('Đã TẮT cảnh báo (Web + phần cứng) cho ' + currentRoom, 'warn');
            } else {
              setHdr('Đã BẬT cảnh báo (Web + phần cứng) cho ' + currentRoom, 'ok');
              const st = stateCache[currentRoom];
              if (st && st.alarmTemp === 1) updateAlarmBadge(currentRoom, 1, st.alarmDir || 0);
            }
          });
        }

        function lowHighSeriesFor(room, len) {
          const c = pelCache[room];
          const fill = (v) => Array.from({ length: len }, () => (Number.isFinite(v) ? v : null));
          return { lo: fill(c?.lowC), hi: fill(c?.highC) };
        }

        function applyChartRoom(room) {
          const v = buildViewSeries(room);

          chart.data.labels = v.labels;
          chart.data.datasets[0].data = v.t;
          chart.data.datasets[1].data = v.h;

          const bands = lowHighSeriesFor(room, v.labels.length);
          chart.data.datasets[2].data = bands.lo;
          chart.data.datasets[3].data = bands.hi;

          chart.data.datasets[4].data = v.alarmOnPts;
          chart.data.datasets[5].data = v.alarmOffPts;
          chart.data.datasets[6].data = v.doorOpenPts;
          chart.data.datasets[7].data = v.doorClosedPts;

          chart.update('none');
        }

        // cập nhật lại chart khi bật/tắt markers
        [chkDoorMarkers, chkAlarmOnMarkers, chkAlarmOffMarkers].forEach(el => {
          if (!el) return;
          el.addEventListener('change', () => applyChartRoom(currentRoom));
        });

        // ===== Events -> history raw =====
        function recordTelemetry(room, t, h) {
          const st = stateCache[room] || {};
          const door = (st.door === 1) ? 1 : 0;
          const alarmTemp = (st.alarmTemp === 1) ? 1 : 0;
          const alarmDir = Number(st.alarmDir || 0);
          pushRaw(room, [Date.now(), Number(t), Number(h), door, alarmTemp, alarmDir, 0]);
        }

        function recordDoorEvent(room, door01) {
          const st = stateCache[room] || {};
          const t = Number.isFinite(st.lastT) ? st.lastT : (Number.isFinite(latestTH[room]?.t) ? latestTH[room].t : 0);
          const h = Number.isFinite(st.lastH) ? st.lastH : (Number.isFinite(latestTH[room]?.h) ? latestTH[room].h : 0);
          const alarmTemp = (st.alarmTemp === 1) ? 1 : 0;
          const alarmDir = Number(st.alarmDir || 0);
          pushRaw(room, [Date.now(), Number(t), Number(h), (door01 ? 1 : 0), alarmTemp, alarmDir, 1]);
        }

        function recordAlarmEvent(room, alarmOn01, dir) {
          const st = stateCache[room] || {};
          const t = Number.isFinite(st.lastT) ? st.lastT : (Number.isFinite(latestTH[room]?.t) ? latestTH[room].t : 0);
          const h = Number.isFinite(st.lastH) ? st.lastH : (Number.isFinite(latestTH[room]?.h) ? latestTH[room].h : 0);
          const door = (st.door === 1) ? 1 : 0;
          const a = alarmOn01 ? 1 : 0;
          const d = Number(dir || 0);
          pushRaw(room, [Date.now(), Number(t), Number(h), door, a, d, alarmOn01 ? 2 : 3]);
        }

        // ===== UI badges + cập nhật event =====
        function updateDoorBadge(room, val01) {
          const open = Number(val01) === 1;

          const prev = stateCache[room].door;
          stateCache[room].door = open ? 1 : 0;

          if (prev !== null && prev !== stateCache[room].door) {
            recordDoorEvent(room, stateCache[room].door);
          }

          if (room === currentRoom) {
            doorBadge.classList.remove('open', 'closed');
            doorBadge.classList.add(open ? 'open' : 'closed');
            doorText.textContent = 'Cửa: ' + (open ? 'Mở' : 'Đóng');
            applyChartRoom(room);
          }
        }

        function updateAlarmBadge(room, val01, dir) {
          const on = Number(val01) === 1;
          const prev = stateCache[room].alarmTemp;

          stateCache[room].alarmTemp = on ? 1 : 0;
          stateCache[room].alarmDir = Number(dir) || 0;

          // event: ON/OFF transition -> marker
          if (prev !== null && prev !== stateCache[room].alarmTemp) {
            recordAlarmEvent(room, stateCache[room].alarmTemp === 1, stateCache[room].alarmDir);
          }

          if (!isAlarmWebEnabled(room)) {
            if (room === currentRoom) {
              alarmBadge.classList.add('hidden');
              alarmLED.classList.add('hidden');
              alarmLED.classList.remove('red', 'pulse');
              alarmText.textContent = 'ALARM: —';
              applyChartRoom(room);
            }
            return;
          }

          if (room === currentRoom) {
            alarmBadge.classList.toggle('hidden', !on);

            const dirTxt = (stateCache[room].alarmDir < 0) ? 'QUÁ THẤP'
              : (stateCache[room].alarmDir > 0) ? 'QUÁ CAO'
                : 'VƯỢT NGƯỠNG';

            alarmText.textContent = on ? ('ALARM: ' + dirTxt) : 'ALARM: —';
            alarmDot.className = 'dot ' + (on ? 'err' : '');
            alarmLED.classList.toggle('hidden', !on);

            if (on) {
              alarmLED.classList.add('red', 'pulse');
              if (prev !== 1) setHdr('Cảnh báo: Nhiệt độ ' + dirTxt + '!', 'err');
            } else {
              alarmLED.classList.remove('red', 'pulse');
            }
            applyChartRoom(room);
          }
        }

        function syncAlarmEnableFromESP(room, val01) {
          const en = Number(val01) === 1;
          stateCache[room].alarmEnable = en ? 1 : 0;

          alarmWebEnable[room] = en;
          try { localStorage.setItem(LS_ALARM_WEB_PREFIX + room, en ? '1' : '0'); } catch { }

          if (room === currentRoom && alarmEnableWebEl) {
            alarmEnableWebEl.checked = en;
            applyAlarmWebUI(room);
          }
        }

        function handleStateFrom(room, msg) {
          if (!isSysEnabled(room)) return;

          try {
            const o = JSON.parse(msg);

            if (o.alarmEnable !== undefined) syncAlarmEnableFromESP(room, o.alarmEnable);

            if (o.door !== undefined) {
              const dv = o.door === true ? 1 : o.door === false ? 0 : Number(o.door);
              if (dv === 0 || dv === 1) updateDoorBadge(room, dv);
            }
            if (o.alarmTemp !== undefined) {
              const av = o.alarmTemp === true ? 1 : o.alarmTemp === false ? 0 : Number(o.alarmTemp);
              const dir = (o.alarmDir !== undefined) ? Number(o.alarmDir) : 0;
              if (av === 0 || av === 1) updateAlarmBadge(room, av, dir);
            }
          } catch (e) { console.warn('STATE JSON error', e); }
        }

        function handleTelemetryFrom(room, msg) {
          if (!isSysEnabled(room)) return;

          let t = null, h = null, av = null, dir = 0;
          try {
            const o = JSON.parse(msg);

            if (o.alarmEnable !== undefined) syncAlarmEnableFromESP(room, o.alarmEnable);

            t = o.temp ?? o.temperature ?? o.T ?? null;
            h = o.humi ?? o.humidity ?? o.H ?? null;
            if (o.alarmTemp !== undefined) av = o.alarmTemp === true ? 1 : o.alarmTemp === false ? 0 : Number(o.alarmTemp);
            if (o.alarmDir !== undefined) dir = Number(o.alarmDir) || 0;
          } catch (e) {
            const parts = String(msg).split(/[;,\s]+/).filter(Boolean);
            if (parts.length >= 2) { t = parseFloat(parts[0]); h = parseFloat(parts[1]); }
          }

          if (Number.isFinite(t) && Number.isFinite(h)) {
            latestTH[room] = { t: Number(t), h: Number(h), ts: Date.now() };
            if (allRoomsOn) renderAllRooms();

            // update big cards if current room
            if (room === currentRoom) {
              const tr = document.createElement('tr');
              tr.innerHTML = `<td>${Number(t).toFixed(1)}</td><td>${Number(h).toFixed(1)}</td>`;
              tbody.replaceChildren(tr);
              const tEl = document.getElementById('tempBig');
              const hEl = document.getElementById('humiBig');
              if (tEl) tEl.textContent = Number(t).toFixed(1);
              if (hEl) hEl.textContent = Number(h).toFixed(1);
            }

            // store last t/h in stateCache for marker y
            stateCache[room].lastT = Number(t);
            stateCache[room].lastH = Number(h);

            // record history raw
            recordTelemetry(room, t, h);

            // push to table log (per room)
            const note = (stateCache[room]?.alarmTemp === 1) ? 'ALARM ON' : '';
            pushTHLog(room, t, h, note);

            if (room === currentRoom) applyChartRoom(room);
          }

          if (av === 0 || av === 1) updateAlarmBadge(room, av, dir);
        }

        // ===== Peltier localStorage =====
        const LS_PEL_PREFIX = 'pel.ctrl.v6.';
        const pelKey = room => LS_PEL_PREFIX + room;

        function loadPel(room) {
          const defR = defaultRange(room);
          const spDef = defR.low;
          const def = {
            mode: 'manual', enable: 1, duty: 0, minDuty: 0, maxDuty: 255,
            setpointC: spDef,
            boostBandC: 2.0,
            autoHysC: 0.3,
            autoMinDuty: 80,
            autoMaxDuty: 255,
            lowC: defR.low, highC: defR.high,
            ...bandsFromLowHigh(defR.low, defR.high),
          };

          try {
            const s = JSON.parse(localStorage.getItem(pelKey(room)) || 'null');
            if (s && typeof s === 'object') {
              const toNum = (x, fb) => { const v = parseFloat(x); return Number.isFinite(v) ? v : fb; };
              const lowC = toNum(s.lowC, def.lowC);
              const highC = toNum(s.highC, def.highC);
              const b = bandsFromLowHigh(lowC, highC) || bandsFromLowHigh(def.lowC, def.highC);

              const mode = String(s.mode || 'manual').toLowerCase();
              return {
                mode: (mode === 'off') ? 'off' : (mode === 'auto' ? 'auto' : 'manual'),
                enable: s.enable ? 1 : 0,
                duty: clamp(s.duty ?? 0, 0, 255),
                minDuty: clamp(s.minDuty ?? 0, 0, 255),
                maxDuty: clamp(s.maxDuty ?? 255, 0, 255),

                setpointC: toNum(s.setpointC, def.setpointC),
                boostBandC: toNum(s.boostBandC, def.boostBandC),
                autoHysC: toNum(s.autoHysC, def.autoHysC),
                autoMinDuty: clamp(s.autoMinDuty ?? def.autoMinDuty, 0, 255),
                autoMaxDuty: clamp(s.autoMaxDuty ?? def.autoMaxDuty, 0, 255),

                lowC: b.low,
                highC: b.high,
                alarmLowC: b.alarmLowC,
                alarmHighC: b.alarmHighC,
                clearLowC: b.clearLowC,
                clearHighC: b.clearHighC,
              };
            }
          } catch (e) { }
          return def;
        }

        function savePel(room) {
          try {
            const c = pelCache[room];
            const pack = {
              mode: c.mode || 'manual',
              enable: c.enable ? 1 : 0,
              duty: clamp(c.duty ?? 0, 0, 255),
              minDuty: clamp(c.minDuty ?? 0, 0, 255),
              maxDuty: clamp(c.maxDuty ?? 255, 0, 255),

              setpointC: Number(c.setpointC),
              boostBandC: Number(c.boostBandC),
              autoHysC: Number(c.autoHysC),
              autoMinDuty: clamp(c.autoMinDuty ?? 0, 0, 255),
              autoMaxDuty: clamp(c.autoMaxDuty ?? 255, 0, 255),

              lowC: c.lowC,
              highC: c.highC,

              alarmLowC: c.alarmLowC,
              alarmHighC: c.alarmHighC,
              clearLowC: c.clearLowC,
              clearHighC: c.clearHighC,
            };
            localStorage.setItem(pelKey(room), JSON.stringify(pack));
          } catch (e) { }
        }

        pelCache.room1 = loadPel('room1');
        pelCache.room2 = loadPel('room2');
        pelCache.room3 = loadPel('room3');

        const pelEnable = document.getElementById('peltierEnable');
        const pelSlider = document.getElementById('peltierSlider');
        const pelDutyLbl = document.getElementById('pelDutyLbl');
        const pelPctLbl = document.getElementById('pelPctLbl');
        const pelModeLbl = document.getElementById('pelModeLbl');
        const modeAutoBtn = document.getElementById('modeAuto');
        const modeManualBtn = document.getElementById('modeManual');
        const modeOffBtn = document.getElementById('modeOff');

        let isDraggingDuty = false;
        let isEditingRange = false;

        function setRangeInputsFromCache(room) {
          const c = pelCache[room];
          if (!c) return;
          if (!isEditingRange) {
            rangeLowInput.value = Number(c.lowC).toFixed(1);
            rangeHighInput.value = Number(c.highC).toFixed(1);
          }
          bandExplain.textContent =
            `ALARM: ${Number(c.alarmLowC).toFixed(1)}–${Number(c.alarmHighC).toFixed(1)}°C | ` +
            `TẮT khi về: ${Number(c.clearLowC).toFixed(1)}–${Number(c.clearHighC).toFixed(1)}°C`;
        }

        function setAutoInputsFromCache(room) {
          const c = pelCache[room];
          if (!c) return;
          safeSetAutoInput('sp', autoSetpoint, Number(c.setpointC).toFixed(1));
          safeSetAutoInput('boost', autoBoostBand, Number(c.boostBandC).toFixed(1));
          safeSetAutoInput('hys', autoHys, Number(c.autoHysC).toFixed(1));
          safeSetAutoInput('min', autoMinDuty, String(clamp(c.autoMinDuty ?? 0, 0, 255)));
          safeSetAutoInput('max', autoMaxDuty, String(clamp(c.autoMaxDuty ?? 255, 0, 255)));
          autoExplain.textContent =
            `SP=${Number(c.setpointC).toFixed(1)}°C, boost=${Number(c.boostBandC).toFixed(1)}°C, hys=${Number(c.autoHysC).toFixed(1)}°C`;
        }

        function applyPeltierUI(room) {
          const c = pelCache[room];
          pelModeLbl.textContent = String(c.mode || '—').toUpperCase();


          [modeAutoBtn, modeManualBtn, modeOffBtn].forEach(b => b.classList.remove('active'));
          if (c.mode === 'auto') modeAutoBtn.classList.add('active');
          else if (c.mode === 'manual') modeManualBtn.classList.add('active');
          else if (c.mode === 'off') modeOffBtn.classList.add('active');

          pelEnable.checked = !!c.enable;

          pelSlider.min = String(Number.isFinite(c.minDuty) ? c.minDuty : 0);
          pelSlider.max = String(Number.isFinite(c.maxDuty) ? c.maxDuty : 255);
          if (!isDraggingDuty && Number.isFinite(c.duty)) pelSlider.value = String(c.duty);

          pelDutyLbl.textContent = Number.isFinite(c.duty) ? c.duty : (pelSlider.value | 0);
          pelPctLbl.textContent = Math.round(100 * (pelSlider.value | 0) / 255);

          pelSlider.disabled = (!pelEnable.checked) || (c.mode !== 'manual');

          setAutoInputsFromCache(room);
          setRangeInputsFromCache(room);
        }

        function handlePeltierStateFrom(room, json) {
          if (!isSysEnabled(room)) return;

          try {
            const o = JSON.parse(json);
            const c = pelCache[room];

            if (o.alarmEnable !== undefined) syncAlarmEnableFromESP(room, o.alarmEnable);

            const m = String(o.mode || c.mode || 'manual').toLowerCase();
            c.mode = (m === 'off') ? 'off' : (m === 'auto' ? 'auto' : 'manual');

            if (o.enable !== undefined) c.enable = o.enable ? 1 : 0;
            if (typeof o.duty === 'number') c.duty = clamp(o.duty, 0, 255);
            if (typeof o.minDuty === 'number') c.minDuty = clamp(o.minDuty, 0, 255);
            if (typeof o.maxDuty === 'number') c.maxDuty = clamp(o.maxDuty, 0, 255);

            if (typeof o.setpointC === 'number') c.setpointC = o.setpointC;
            if (typeof o.boostBandC === 'number') c.boostBandC = o.boostBandC;
            if (typeof o.autoHysC === 'number') c.autoHysC = o.autoHysC;
            if (typeof o.autoMinDuty === 'number') c.autoMinDuty = clamp(o.autoMinDuty, 0, 255);
            if (typeof o.autoMaxDuty === 'number') c.autoMaxDuty = clamp(o.autoMaxDuty, 0, 255);

            if (typeof o.alarmLowC === 'number') c.alarmLowC = o.alarmLowC;
            if (typeof o.alarmHighC === 'number') c.alarmHighC = o.alarmHighC;
            if (typeof o.clearLowC === 'number') c.clearLowC = o.clearLowC;
            if (typeof o.clearHighC === 'number') c.clearHighC = o.clearHighC;

            const derived = deriveLowHighFromBands(c);
            if (derived) { c.lowC = derived.low; c.highC = derived.high; }
            else {
              const b = bandsFromLowHigh(c.lowC, c.highC);
              if (b) Object.assign(c, b);
            }

            savePel(room);
            if (room === currentRoom) { applyPeltierUI(room); applyChartRoom(room); }
          } catch (e) { console.warn('PELTIER_STATE JSON error', e); }
        }

        function handlePeltierTeleFrom(room, json) {
          if (!isSysEnabled(room)) return;

          try {
            const o = JSON.parse(json);
            const c = pelCache[room];

            if (o.alarmEnable !== undefined) syncAlarmEnableFromESP(room, o.alarmEnable);

            if (typeof o.duty === 'number') c.duty = clamp(o.duty, 0, 255);
            if (typeof o.mode === 'string') {
              const m = o.mode.toLowerCase();
              c.mode = (m === 'off') ? 'off' : (m === 'auto' ? 'auto' : 'manual');
            }
            savePel(room);
            if (room === currentRoom) applyPeltierUI(room);

            if (o.alarmTemp !== undefined) {
              const av = o.alarmTemp === true ? 1 : o.alarmTemp === false ? 0 : Number(o.alarmTemp);
              const dir = (o.alarmDir !== undefined) ? Number(o.alarmDir) : 0;
              if (av === 0 || av === 1) updateAlarmBadge(room, av, dir);
            }
          } catch (e) { console.warn('PELTIER_TELE JSON error', e); }
        }

        pelEnable.addEventListener('change', () => {
          const v = pelEnable.checked ? 1 : 0;
          pelCache[currentRoom].enable = v;
          savePel(currentRoom);
          sendPelCmd({ enable: !!v });
        });

        modeManualBtn.addEventListener('click', () => {
          pelCache[currentRoom].mode = 'manual';
          savePel(currentRoom);
          applyPeltierUI(currentRoom);
          sendPelCmd({ mode: 'manual', duty: (pelSlider.value | 0), enable: !!pelEnable.checked });
        });

        modeOffBtn.addEventListener('click', () => {
          pelCache[currentRoom].mode = 'off';
          savePel(currentRoom);
          applyPeltierUI(currentRoom);
          sendPelCmd({ mode: 'off', enable: 0 });
        });

        modeAutoBtn.addEventListener('click', () => {
          pelCache[currentRoom].mode = 'auto';
          savePel(currentRoom);
          applyPeltierUI(currentRoom);
          const c = pelCache[currentRoom];
          sendPelCmd({
            mode: 'auto',
            enable: !!pelEnable.checked,
            setpointC: Number(c.setpointC),
            boostBandC: Number(c.boostBandC),
            autoHysC: Number(c.autoHysC),
            autoMinDuty: clamp(c.autoMinDuty, 0, 255),
            autoMaxDuty: clamp(c.autoMaxDuty, 0, 255),
          });
        });

        const sendDutyDebounced = debounce(() => {
          const d = pelSlider.value | 0;
          pelCache[currentRoom].duty = d;
          savePel(currentRoom);
          sendPelCmd({ mode: 'manual', duty: d, enable: !!pelEnable.checked });
          isDraggingDuty = false;
        }, 140);

        pelSlider.addEventListener('input', () => {
          isDraggingDuty = true;
          pelDutyLbl.textContent = pelSlider.value;
          pelCache[currentRoom].duty = pelSlider.value | 0;
          savePel(currentRoom);
          sendDutyDebounced();
        });

        pelSlider.addEventListener('change', () => {
          isDraggingDuty = false;
          const d = pelSlider.value | 0;
          pelCache[currentRoom].duty = d;
          savePel(currentRoom);
          sendPelCmd({ mode: 'manual', duty: d, enable: !!pelEnable.checked });
        });

        autoApplyBtn.addEventListener('click', () => {
          autoDirty.sp = autoDirty.boost = autoDirty.hys = autoDirty.min = autoDirty.max = false;
          const c = pelCache[currentRoom];
          c.setpointC = parseFloat(autoSetpoint.value);
          c.boostBandC = parseFloat(autoBoostBand.value);
          c.autoHysC = parseFloat(autoHys.value);
          c.autoMinDuty = clamp(parseInt(autoMinDuty.value || '0', 10), 0, 255);
          c.autoMaxDuty = clamp(parseInt(autoMaxDuty.value || '255', 10), 0, 255);
          if (c.autoMaxDuty < c.autoMinDuty) { const t = c.autoMaxDuty; c.autoMaxDuty = c.autoMinDuty; c.autoMinDuty = t; }
          savePel(currentRoom);
          applyPeltierUI(currentRoom);

          pelCache[currentRoom].mode = 'auto';
          savePel(currentRoom);

          sendPelCmd({
            mode: 'auto',
            enable: !!pelEnable.checked,
            setpointC: Number(c.setpointC),
            boostBandC: Number(c.boostBandC),
            autoHysC: Number(c.autoHysC),
            autoMinDuty: clamp(c.autoMinDuty, 0, 255),
            autoMaxDuty: clamp(c.autoMaxDuty, 0, 255),
          });
          setHdr('Đã áp dụng AUTO', 'ok');
        });

        [rangeLowInput, rangeHighInput].forEach(inp => {
          inp.addEventListener('focus', () => isEditingRange = true);
          inp.addEventListener('blur', () => { setTimeout(() => { isEditingRange = false; }, 120); });
        });

        function readLowHighFromInputs() {
          const low = parseFloat(rangeLowInput.value);
          const high = parseFloat(rangeHighInput.value);
          const b = bandsFromLowHigh(low, high);
          return b;
        }

        bandSaveBtn.addEventListener('click', () => {
          const b = readLowHighFromInputs();
          if (!b) { setHdr('Ngưỡng không hợp lệ (cần đủ 2 số LOW/HIGH)', 'err'); return; }

          Object.assign(pelCache[currentRoom], b);
          savePel(currentRoom);
          applyPeltierUI(currentRoom);
          applyChartRoom(currentRoom);

          sendPelCmd({ alarmLowC: b.alarmLowC, alarmHighC: b.alarmHighC, clearLowC: b.clearLowC, clearHighC: b.clearHighC });
        });

        bandDefaultBtn.addEventListener('click', () => {
          const r = defaultRange(currentRoom);
          const b = bandsFromLowHigh(r.low, r.high);
          Object.assign(pelCache[currentRoom], b);
          savePel(currentRoom);
          applyPeltierUI(currentRoom);
          applyChartRoom(currentRoom);

          sendPelCmd({ alarmLowC: b.alarmLowC, alarmHighC: b.alarmHighC, clearLowC: b.clearLowC, clearHighC: b.clearHighC });
          setHdr('Đã áp dụng ngưỡng mặc định theo ' + currentRoom, 'ok');
        });

        function pushPelFromStorage(room) {
          const s = pelCache[room];

          if (s.mode === 'off') {
            sendPelCmd({ mode: 'off', enable: 0 });
          } else if (s.mode === 'auto') {
            sendPelCmd({
              mode: 'auto',
              enable: !!s.enable,
              setpointC: Number(s.setpointC),
              boostBandC: Number(s.boostBandC),
              autoHysC: Number(s.autoHysC),
              autoMinDuty: clamp(s.autoMinDuty, 0, 255),
              autoMaxDuty: clamp(s.autoMaxDuty, 0, 255),
            });
          } else {
            sendPelCmd({ mode: 'manual', duty: (s.duty | 0), enable: !!s.enable });
          }

          sendPelCmd({ alarmLowC: s.alarmLowC, alarmHighC: s.alarmHighC, clearLowC: s.clearLowC, clearHighC: s.clearHighC });
        }

        document.getElementById('histClear').addEventListener('click', () => {
          histRaw[currentRoom] = [];
          try { localStorage.removeItem(LS_HRAW_PREFIX + currentRoom); } catch (e) { }
          applyChartRoom(currentRoom);
          setHdr('Đã xoá lịch sử biểu đồ của ' + currentRoom, 'warn');
        });

        function applyRoomSwitch(room) {
          applyPeltierUI(room);
          applyAlarmWebUI(room);
          applyChartRoom(room);
          applySysEnableUI(room);

          if (client && client.connected) {
            try { client.publish(TOPIC.pub(room), JSON.stringify({ getState: 1 }), { qos: 0, retain: false }); } catch (e) { }
          }
          setTimeout(() => pushPelFromStorage(room), 300);

          // nếu modal đang mở -> đổi theo phòng
          if (thOverlay.classList.contains('active')) renderTHTable();
        }

        loadTHTable();
        applyPeltierUI(currentRoom);
        applyAlarmWebUI(currentRoom);
        applyChartRoom(currentRoom);

        return {
          handleStateFrom,
          handleTelemetryFrom,
          handlePeltierStateFrom,
          handlePeltierTeleFrom,
          applyRoomSwitch,
          pushPelFromStorage,
        };
      })();

      // ===== ROOM selector =====
      const roomBtns = Array.from(document.querySelectorAll('.roombtn'));
      const roomBrokerEl = document.getElementById('roomBroker');
      const roomSubEl = document.getElementById('roomSub');
      const roomStateEl = document.getElementById('roomState');
      const roomPubEl = document.getElementById('roomPub');
      const pelCmdTopicEl = document.getElementById('pelCmdTopic');
      const pelStateTopicEl = document.getElementById('pelStateTopic');
      const pelTeleTopicEl = document.getElementById('pelTeleTopic');

      function refreshRoomLabels() {
        if (roomBrokerEl) roomBrokerEl.textContent = `${HOST}:${PORT}${PATH}`;
        if (roomSubEl) roomSubEl.textContent = TOPIC.teleOf(currentRoom);
        if (roomStateEl) roomStateEl.textContent = TOPIC.stateOf(currentRoom);
        if (roomPubEl) roomPubEl.textContent = TOPIC.pub(currentRoom);
        if (pelCmdTopicEl) pelCmdTopicEl.textContent = TOPIC.peltierCmdOf(currentRoom);
        if (pelStateTopicEl) pelStateTopicEl.textContent = `coldroom/${currentRoom}/peltier_state`;
        if (pelTeleTopicEl) pelTeleTopicEl.textContent = `coldroom/${currentRoom}/peltier_tele`;
      }

      function setCurrentRoom(room) {
        if (!ROOMS.includes(room)) return;
        currentRoom = room;
        localStorage.setItem('coldroom.currentRoom', currentRoom);
        roomBtns.forEach(b => b.classList.toggle('active', b.dataset.room === room));
        refreshRoomLabels();
        roomMod.applyRoomSwitch(room);
      }

      roomBtns.forEach(b => b.addEventListener('click', () => setCurrentRoom(b.dataset.room)));
      refreshRoomLabels();
      setCurrentRoom(currentRoom);

      // RFID labels
      document.getElementById('rfidBroker').textContent = `${HOST}:${PORT}${PATH}`;
      document.getElementById('rfidTopic').textContent = TOPIC.rfid;

      // ===== MQTT connect =====
      setHdr('Đang kết nối…', 'warn');
      client = mqtt.connect(WS_URL, {
        clientId: 'webapp-' + Math.random().toString(16).slice(2),
        username: USERNAME,
        password: PASSWORD,
        clean: true,
        reconnectPeriod: 2000,
        connectTimeout: 15000,
        keepalive: 60,
        protocolVersion: 4,
      });

      client.on('connect', () => {
        setHdr('Đã kết nối', 'ok');
        client.subscribe(
          [TOPIC.rfid, TOPIC.tele, TOPIC.state, TOPIC.peltierState, TOPIC.peltierTele],
          { qos: 0 },
          err => {
            if (err) setHdr('Sub lỗi: ' + err.message, 'err');
            else {
              try { client.publish(TOPIC.pub(currentRoom), JSON.stringify({ getState: 1 }), { qos: 0, retain: false }); } catch (e) { }
              setTimeout(() => roomMod.pushPelFromStorage(currentRoom), 400);
            }
          }
        );
      });

      client.on('reconnect', () => setHdr('Đang thử kết nối lại…', 'warn'));
      client.on('close', () => setHdr('Mất kết nối', 'err'));
      client.on('error', e => setHdr('Lỗi: ' + (e?.message || e), 'err'));

      client.on('message', (topic, payload) => {
        const msg = payload.toString();
        if (topic === TOPIC.rfid) return rfidModule.handleRFIDMessage(msg);

        const room = parseRoomFromTopic(topic);

        if (topic.startsWith('coldroom/') && topic.endsWith('/out1'))
          return roomMod.handleStateFrom(room, msg);

        if (topic.startsWith('coldroom/') && topic.endsWith('/DHT22'))
          return roomMod.handleTelemetryFrom(room, msg);

        if (topic.startsWith('coldroom/') && topic.endsWith('/peltier_state'))
          return roomMod.handlePeltierStateFrom(room, msg);

        if (topic.startsWith('coldroom/') && topic.endsWith('/peltier_tele'))
          return roomMod.handlePeltierTeleFrom(room, msg);
      });

      console.warn('⚠️ Lưu ý: MQTT USERNAME/PASSWORD đang ở client-side. Khi triển khai thật nên dùng proxy hoặc token tạm thời.');
    })();