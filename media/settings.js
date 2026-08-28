const vscode = acquireVsCodeApi();
const SERVER_ROOT = document
  .getElementById("settings-script")
  .getAttribute("data-server-root");
const setupStatusEl = document.getElementById("setup-status");
const setupStatusIconEl = document.getElementById("setup-status-icon");
const setupStatusTextEl = document.getElementById("setup-status-text");
const switchButton = document.getElementById("btn-switch");
const languageSelect = document.getElementById("language-select");
let currentLanguage = "en-US";

const I18N = {
  "zh-CN": {
    language: "语言", auto: "自动", chinese: "中文", english: "English",
    refresh: "刷新", setWallpaper: "设置壁纸", browser: "浏览器", folder: "目录",
    serverStatus: "服务器状态", testHttp: "测试 HTTP", testWs: "测试 WS", stopServer: "停止服务",
    wallpaperInfo: "壁纸信息", name: "名称", type: "类型", entry: "入口", path: "路径",
    search: "搜索设置…", transparencyCss: "透明化与 CSS", customCss: "自定义 CSS",
    editCss: "在编辑器中编辑", saveCss: "保存 CSS 设置", transparencyRules: "透明化规则",
    enableTransparency: "启用透明化", baseColor: "基色（可选）", set: "设置",
    transparencyHint: "切换元素以使其透明。调整不透明度（0 = 完全透明，1 = 完全不透明）。",
    applyRules: "应用透明化规则", generalSimulation: "通用模拟", wallpaperProperties: "壁纸属性",
    waiting: "等待操作", loading: "加载中…", checking: "检查中…", failed: "失败", connected: "已连接",
    stopped: "已停止", unknown: "未知", error: "错误", exception: "异常", invalidColor: "颜色格式无效。请输入十六进制颜色（例如 #1e1e1e），或留空使用自动。",
    compatibility: "主题兼容", compatibilityDetected: "已检测到 C/C++ Theme，兼容层已启用", compatibilityNotDetected: "未检测到 C/C++ Theme 主题",
    compatibilityForced: "已强制启用主题兼容层", compatibilityDisabled: "主题兼容层已关闭", currentTheme: "当前主题"
  },
  "en-US": {
    language: "Language", auto: "Auto", chinese: "中文", english: "English",
    refresh: "Refresh", setWallpaper: "Set Wallpaper", browser: "Browser", folder: "Folder",
    serverStatus: "Server Status", testHttp: "Test HTTP", testWs: "Test WS", stopServer: "Stop Server",
    wallpaperInfo: "Wallpaper Info", name: "Name", type: "Type", entry: "Entry", path: "Path",
    search: "Search settings…", transparencyCss: "Transparency & CSS", customCss: "Custom CSS",
    editCss: "Edit in Editor", saveCss: "Save CSS Settings", transparencyRules: "Transparency Rules",
    enableTransparency: "Enable Transparency", baseColor: "Base Color (Optional)", set: "Set",
    transparencyHint: "Toggle elements to make them transparent. Adjust opacity (0 = Invisible, 1 = Opaque).",
    applyRules: "Apply Transparency Rules", generalSimulation: "General Simulation", wallpaperProperties: "Wallpaper Properties",
    waiting: "Waiting for operation", loading: "Loading…", checking: "Checking…", failed: "Failed", connected: "Connected",
    stopped: "Stopped", unknown: "Unknown", error: "Error", exception: "Exception", invalidColor: "Invalid color format. Use Hex (e.g. #1e1e1e) or leave empty for Auto.",
    compatibility: "Theme compatibility", compatibilityDetected: "C/C++ Theme detected; compatibility layer enabled", compatibilityNotDetected: "No C/C++ Theme detected",
    compatibilityForced: "Theme compatibility layer forced on", compatibilityDisabled: "Theme compatibility layer is off", currentTheme: "Current theme"
  }
};

function t(key) {
  return (I18N[currentLanguage] && I18N[currentLanguage][key]) || I18N["en-US"][key] || key;
}

function localizeStatusMessage(message) {
  if (currentLanguage === "zh-CN" || !message) return message;
  const exact = {
    "等待操作": "Waiting for operation", "未找到可用壁纸": "No usable wallpapers found", "已取消设置壁纸": "Wallpaper setup cancelled",
    "正在检查扩展配置…": "Checking extension configuration…", "正在扫描壁纸库…": "Scanning wallpaper library…", "正在等待选择壁纸…": "Waiting for wallpaper selection…",
    "正在校验壁纸媒体…": "Validating wallpaper media…", "正在启动本地服务…": "Starting local server…", "正在检查服务状态…": "Checking server status…",
    "正在验证壁纸入口…": "Verifying wallpaper entry…", "正在应用界面透明化…": "Applying UI transparency…", "正在写入 Workbench…": "Writing Workbench patch…",
    "正在保存壁纸配置…": "Saving wallpaper configuration…", "正在重新加载窗口…": "Reloading window…",
    "窗口重载后的生效验证失败": "Post-reload wallpaper verification failed",
    "无法清除旧还原事务，未启动壁纸设置": "Could not clear the previous restore transaction; wallpaper setup did not start",
    "请先配置正确的 Wallpaper Engine 创意工坊目录。": "Configure a valid Wallpaper Engine workshop directory first."
  };
  if (exact[message]) return exact[message];
  const active = message.match(/^壁纸「(.+)」已生效$/);
  if (active) return `Wallpaper "${active[1]}" is active`;
  const reloadFailure = message.match(/^窗口重载后未确认壁纸生效（(.+)），请查看日志并重试$/);
  if (reloadFailure) return `Wallpaper was not confirmed after reload (${reloadFailure[1]}). Check the log and retry.`;
  const setupFailure = message.match(/^设置壁纸失败（(.+)）：(.+)$/);
  if (setupFailure) return `Wallpaper setup failed at ${setupFailure[1]}: ${setupFailure[2]}`;
  return message;
}

function applyLanguage(language, resolvedLanguage) {
  currentLanguage = resolvedLanguage || (language === "zh-CN" ? "zh-CN" : "en-US");
  document.documentElement.lang = currentLanguage;
  if (languageSelect) languageSelect.value = language || "auto";
  const buttons = {
    "btn-refresh": "refresh", "btn-switch": "setWallpaper", "btn-browser": "browser", "btn-folder": "folder",
    "btn-test-http": "testHttp", "btn-test-ws": "testWs", "btn-stop-server": "stopServer",
    "btn-edit-css": "editCss", "btn-save-css": "saveCss", "btn-save-base-color": "set", "btn-save-transparency": "applyRules"
  };
  Object.keys(buttons).forEach((id) => { const el = document.getElementById(id); if (el) el.innerText = t(buttons[id]); });
  const headers = ["serverStatus", "wallpaperInfo", "transparencyCss", "transparencyRules", "generalSimulation", "wallpaperProperties"];
  document.querySelectorAll(".section-header").forEach((el, index) => { if (headers[index]) el.innerText = t(headers[index]); });
  const labels = document.querySelectorAll("#setup-status-text, label[for='language-select']");
  if (labels[1]) labels[1].innerText = t("language");
  const search = document.getElementById("search-input"); if (search) search.placeholder = t("search");
  const customCssLabel = document.querySelector("#input-custom-css")?.parentElement?.parentElement?.querySelector("label"); if (customCssLabel) customCssLabel.innerText = t("customCss");
  const baseColor = document.getElementById("input-base-color"); if (baseColor) baseColor.placeholder = currentLanguage === "zh-CN" ? "自动（例如 #1e1e1e）" : "Auto (e.g. #1e1e1e)";
  const transparency = document.querySelector("#chk-transparency-enabled");
  if (transparency && transparency.parentElement && transparency.parentElement.parentElement) transparency.parentElement.parentElement.firstChild.textContent = t("enableTransparency");
  const baseRow = baseColor && baseColor.parentElement && baseColor.parentElement.parentElement;
  if (baseRow) baseRow.firstChild.textContent = t("baseColor");
  const hint = document.querySelector("#transparencyPanel")?.previousElementSibling; if (hint) hint.innerText = t("transparencyHint");
  const infoLabels = document.querySelectorAll("#info-name, #info-type, #info-entry, #info-path");
  ["name", "type", "entry", "path"].forEach((key, index) => { const el = infoLabels[index]?.parentElement?.querySelector("strong"); if (el) el.innerText = `${t(key)}:`; });
  renderGeneralSettings();
  if (window.lastWallpaperProject) renderUI(window.lastWallpaperProject);
  if (window.lastCompatibilityState) renderCompatibilityStatus(window.lastCompatibilityState);
}

function renderCompatibilityStatus(state) {
  window.lastCompatibilityState = state;
  const el = document.getElementById("theme-compatibility-status");
  if (!el) return;
  const reasonKey = state.enabled ? (state.reason === "forced" ? "compatibilityForced" : "compatibilityDetected") : (state.reason === "disabled" ? "compatibilityDisabled" : "compatibilityNotDetected");
  const theme = state.theme || t("unknown");
  el.innerText = `${t("compatibility")}: ${t(reasonKey)} · ${t("currentTheme")}: ${theme}`;
  el.dataset.status = state.enabled ? "success" : "idle";
}

function renderSetupState(state) {
  window.lastSetupState = state;
  const status = state && state.status ? state.status : "idle";
  const icons = { idle: "i", running: "…", success: "✓", error: "!" };
  setupStatusEl.dataset.status = status;
  setupStatusIconEl.innerText = icons[status] || "i";
  setupStatusTextEl.innerText = localizeStatusMessage(state.message) || t("waiting");
  switchButton.disabled = status === "running";
}

window.addEventListener("message", (event) => {
  if (event.data && event.data.type === "setupState") {
    renderSetupState(event.data.state);
  }
  if (event.data && event.data.type === "language") {
    applyLanguage(event.data.language, event.data.resolvedLanguage);
    renderSetupState({ ...window.lastSetupState, message: window.lastSetupState?.message || t("waiting") });
  }
  if (event.data && event.data.type === "compatibilityStatus") {
    renderCompatibilityStatus(event.data.state);
  }
  if (event.data && event.data.type === "transparencyRules") {
    window.transparencyRules = event.data.rules || {};
    renderTransparencyRules();
  }
});

languageSelect?.addEventListener("change", () => {
  vscode.postMessage({ command: "setLanguage", language: languageSelect.value });
  applyLanguage(languageSelect.value, languageSelect.value === "zh-CN" ? "zh-CN" : languageSelect.value === "en-US" ? "en-US" : currentLanguage);
});

vscode.postMessage({ command: "ready" });

function updateProp(key, val) {
  vscode.postMessage({ command: "updateProp", key, value: val });
}

function updateGeneral(key, val) {
  vscode.postMessage({ command: "updateGeneral", key, value: val });
}

// --- Toolbar Handlers ---
document.getElementById("btn-refresh").addEventListener("click", () => {
  vscode.postMessage({ command: "refresh" });
});
document.getElementById("btn-switch").addEventListener("click", () => {
  vscode.postMessage({ command: "switch" });
});
document.getElementById("btn-browser").addEventListener("click", () => {
  vscode.postMessage({ command: "openBrowser" });
});
document.getElementById("btn-folder").addEventListener("click", () => {
  vscode.postMessage({ command: "openFolder" });
});

// --- Server Status Handlers ---
const httpStatusEl = document.getElementById("http-status");
const wsStatusEl = document.getElementById("ws-status");

async function checkHTTP() {
  httpStatusEl.innerText = "Checking...";
  httpStatusEl.style.color = "orange";
  try {
    const start = Date.now();
    const res = await fetch(SERVER_ROOT + "/ping");
    const ms = Date.now() - start;
    if (res.ok || res.status === 205) {
      httpStatusEl.innerText = `OK (${ms}ms)`;
      httpStatusEl.style.color = "#4caf50";
    } else {
      httpStatusEl.innerText = `Error ${res.status}`;
      httpStatusEl.style.color = "red";
    }
  } catch (e) {
    httpStatusEl.innerText = "Failed";
    httpStatusEl.style.color = "red";
  }
}

function checkWS() {
  wsStatusEl.innerText = "Connecting...";
  wsStatusEl.style.color = "orange";
  try {
    const wsUrl = SERVER_ROOT.replace("http", "ws");
    const ws = new WebSocket(wsUrl);
    const start = Date.now();

    ws.onopen = () => {
      const ms = Date.now() - start;
      wsStatusEl.innerText = `Connected (${ms}ms)`;
      wsStatusEl.style.color = "#4caf50";
      ws.close();
    };

    ws.onerror = () => {
      wsStatusEl.innerText = "Error";
      wsStatusEl.style.color = "red";
    };
  } catch (e) {
    wsStatusEl.innerText = "Exception";
    wsStatusEl.style.color = "red";
  }
}

document.getElementById("btn-test-http").addEventListener("click", checkHTTP);
document.getElementById("btn-test-ws").addEventListener("click", checkWS);
document.getElementById("btn-stop-server").addEventListener("click", () => {
  vscode.postMessage({ command: "stopServer" });
  httpStatusEl.innerText = "Stopped";
  httpStatusEl.style.color = "red";
  wsStatusEl.innerText = "Stopped";
  wsStatusEl.style.color = "red";
});

// Initial check
setTimeout(() => {
  checkHTTP();
  checkWS();
}, 1000);

// --- Search Handler ---
document.getElementById("search-input").addEventListener("input", (e) => {
  const term = e.target.value.toLowerCase();
  const items = document.querySelectorAll("#propsPanel .control-item");
  items.forEach((item) => {
    const text = item.innerText.toLowerCase();
    if (text.includes(term)) {
      item.classList.remove("hidden");
    } else {
      item.classList.add("hidden");
    }
  });
});

function getSafeValue(p) {
  if (p.value !== undefined && p.value !== null) {
    return p.value;
  }
  if (p.default !== undefined && p.default !== null) {
    return p.default;
  }
  if (p.type === "color") {
    return "1 1 1";
  }
  if (p.type === "slider") {
    return p.min || 0;
  }
  if (p.type === "bool") {
    return false;
  }
  if (p.type === "combo") {
    return (p.options && p.options[0] && p.options[0].value) || "";
  }
  return "";
}

function weColorToHex(str) {
  if (!str || typeof str !== "string") {
    return "#ffffff";
  }
  const parts = str.split(" ").map(parseFloat);
  if (parts.length < 3) {
    return "#ffffff";
  }
  const toHex = (n) => {
    const hex = Math.floor(Math.min(1, Math.max(0, n)) * 255).toString(16);
    return hex.length === 1 ? "0" + hex : hex;
  };
  return "#" + toHex(parts[0]) + toHex(parts[1]) + toHex(parts[2]);
}

function renderGeneralSettings() {
  const panel = document.getElementById("generalPanel");
  panel.innerHTML = "";

  // Audio Source Select
  const audioDiv = document.createElement("div");
  audioDiv.className = "control-item";
  const audioLbl = document.createElement("label");
  audioLbl.innerText = currentLanguage === "zh-CN" ? "音频源" : "Audio Source";
  audioDiv.appendChild(audioLbl);

  const audioSelect = document.createElement("select");
  const audioOptions = [
    { value: "simulate", label: currentLanguage === "zh-CN" ? "模拟（正弦波）" : "Simulate (Sine Wave)" },
    { value: "mic", label: currentLanguage === "zh-CN" ? "麦克风（实时音频）" : "Microphone (Real Audio)" },
    { value: "system", label: currentLanguage === "zh-CN" ? "系统音频（屏幕共享）" : "System Audio (Screen Share)" },
    { value: "off", label: currentLanguage === "zh-CN" ? "关闭（静音）" : "Off (Silence)" },
  ];
  audioOptions.forEach((opt) => {
    const o = document.createElement("option");
    o.value = opt.value;
    o.innerText = opt.label;
    audioSelect.appendChild(o);
  });
  audioSelect.value = "off"; // Default
  audioSelect.onchange = (e) => updateGeneral("audioSource", e.target.value);
  audioDiv.appendChild(audioSelect);
  panel.appendChild(audioDiv);

  const generalProps = [
    {
      key: "audioVolume",
      label: currentLanguage === "zh-CN" ? "音量（0-100）" : "Audio Volume (0-100)",
      type: "slider",
      min: 0,
      max: 100,
      value: 50,
    },
  ];

  generalProps.forEach((p) => {
    const div = document.createElement("div");
    div.className = "control-item";
    const lbl = document.createElement("label");
    lbl.innerText = p.label;
    div.appendChild(lbl);

    let input;
    if (p.type === "slider") {
      const valSpan = document.createElement("span");
      valSpan.innerText = p.value;
      lbl.appendChild(valSpan);
      input = document.createElement("input");
      input.type = "range";
      input.min = p.min;
      input.max = p.max;
      input.value = p.value;
      input.oninput = (e) => {
        valSpan.innerText = e.target.value;
        updateGeneral(p.key, parseFloat(e.target.value));
      };
    } else if (p.type === "bool") {
      input = document.createElement("input");
      input.type = "checkbox";
      input.checked = p.value;
      input.onchange = (e) => updateGeneral(p.key, e.target.checked);
    }

    if (input) {
      div.appendChild(input);
      panel.appendChild(div);
    }
  });
}

function renderUI(json) {
  const panel = document.getElementById("propsPanel");
  panel.innerHTML = "";
  const props =
    json.properties || (json.general && json.general.properties) || {};

  Object.keys(props).forEach((key) => {
    const p = props[key];
    const safeVal = getSafeValue(p);

    const div = document.createElement("div");
    div.className = "control-item";
    const lbl = document.createElement("label");
    // Use innerHTML to render HTML tags in labels
    lbl.innerHTML = p.text || key;
    div.appendChild(lbl);

    let input;
    if (p.type === "slider") {
      const valSpan = document.createElement("span");
      valSpan.innerText = safeVal;
      lbl.appendChild(valSpan);
      input = document.createElement("input");
      input.type = "range";
      input.min = p.min ?? 0;
      input.max = p.max ?? 100;
      input.step = p.step ?? 1;
      input.value = safeVal;
      input.oninput = (e) => {
        let v = parseFloat(e.target.value);
        if (p.step % 1 !== 0) {
          v = parseFloat(v.toFixed(2));
        }
        valSpan.innerText = v;
        updateProp(key, v);
      };
    } else if (p.type === "color") {
      input = document.createElement("input");
      input.type = "color";
      input.value = weColorToHex(safeVal);
      input.oninput = (e) => {
        const h = e.target.value;
        const r = parseInt(h.substr(1, 2), 16) / 255;
        const g = parseInt(h.substr(3, 2), 16) / 255;
        const b = parseInt(h.substr(5, 2), 16) / 255;
        updateProp(key, `${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)}`);
      };
    } else if (p.type === "bool") {
      input = document.createElement("input");
      input.type = "checkbox";
      input.checked = safeVal;
      input.onchange = (e) => updateProp(key, e.target.checked);
    } else if (p.type === "combo") {
      input = document.createElement("select");
      (p.options || []).forEach((opt) => {
        const o = document.createElement("option");
        o.value = opt.value;
        o.innerText = opt.label;
        if (opt.value === safeVal) {
          o.selected = true;
        }
        input.appendChild(o);
      });
      input.onchange = (e) => updateProp(key, e.target.value);
    } else {
      input = document.createElement("input");
      input.type = "text";
      input.value = safeVal;
      input.onchange = (e) => updateProp(key, e.target.value);
    }

    if (input) {
      div.appendChild(input);
      panel.appendChild(div);
    }
  });
}

// --- CSS Settings Handler ---
document.getElementById("btn-edit-css").addEventListener("click", () => {
  vscode.postMessage({ command: "editCustomCss" });
});

document.getElementById("btn-save-css").addEventListener("click", () => {
  const customCss = document.getElementById("input-custom-css").value;

  vscode.postMessage({
    command: "updateCss",
    customCss,
  });
});

// --- Transparency Toggle Handler ---
const chkTransparencyEnabled = document.getElementById(
  "chk-transparency-enabled"
);
const transparencyPanel = document.getElementById("transparencyPanel");
const btnSaveTransparency = document.getElementById("btn-save-transparency");

// Initialize state
chkTransparencyEnabled.checked = window.transparencyEnabled !== false; // Default true
updateTransparencyUIState();

chkTransparencyEnabled.addEventListener("change", () => {
  const enabled = chkTransparencyEnabled.checked;
  updateTransparencyUIState();

  vscode.postMessage({
    command: "toggleTransparency",
    enabled: enabled,
  });
});

function updateTransparencyUIState() {
  const enabled = chkTransparencyEnabled.checked;
  if (enabled) {
    transparencyPanel.style.opacity = "1";
    transparencyPanel.style.pointerEvents = "auto";
    btnSaveTransparency.disabled = false;
    btnSaveTransparency.style.opacity = "1";
  } else {
    transparencyPanel.style.opacity = "0.5";
    transparencyPanel.style.pointerEvents = "none";
    btnSaveTransparency.disabled = true;
    btnSaveTransparency.style.opacity = "0.5";
  }
}

// --- Base Color Handler ---
document.getElementById("btn-save-base-color").addEventListener("click", () => {
  const color = document.getElementById("input-base-color").value.trim();
  // Simple validation
  if (color && !/^#[0-9A-Fa-f]{6}$/.test(color)) {
    // Show error in UI? For now just let backend handle or ignore
    // But let's be nice
    alert(
      "Invalid color format. Use Hex (e.g. #1e1e1e) or leave empty for Auto."
    );
    return;
  }

  vscode.postMessage({
    command: "updateTransparencyBaseColor",
    color: color,
  });
});

// --- Transparency Rules Handler ---
function renderTransparencyRules() {
  const panel = document.getElementById("transparencyPanel");
  const keys = window.transparencyKeys || [];
  const rules = window.transparencyRules || {};

  panel.innerHTML = "";

  keys.forEach((key) => {
    const div = document.createElement("div");
    div.className = "control-item";
    div.style.display = "flex";
    div.style.alignItems = "center";
    div.style.justifyContent = "space-between";
    div.style.marginBottom = "5px";
    div.style.padding = "2px 0";
    div.style.borderBottom = "1px solid #333";

    // Checkbox (Enable/Disable)
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = rules[key] !== undefined;
    checkbox.style.marginRight = "10px";

    // Label
    const label = document.createElement("span");
    label.innerText = key;
    label.style.flex = "1";
    label.style.fontSize = "0.9em";
    label.title = key; // Tooltip

    // Slider Container
    const sliderContainer = document.createElement("div");
    sliderContainer.style.display = "flex";
    sliderContainer.style.alignItems = "center";
    sliderContainer.style.gap = "5px";
    sliderContainer.style.visibility = checkbox.checked ? "visible" : "hidden";

    // Slider (Opacity)
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "1";
    slider.step = "0.01";
    slider.value = rules[key] !== undefined ? rules[key] : 0; // Default 0 (Transparent)
    slider.style.width = "200px";
    slider.style.maxWidth = "45vw";

    // Value Display
    const valDisplay = document.createElement("span");
    valDisplay.innerText = parseFloat(slider.value).toFixed(2);
    valDisplay.style.width = "35px";
    valDisplay.style.textAlign = "right";
    valDisplay.style.fontSize = "0.8em";
    valDisplay.style.fontFamily = "monospace";

    // Events
    checkbox.onchange = () => {
      sliderContainer.style.visibility = checkbox.checked
        ? "visible"
        : "hidden";
    };

    slider.oninput = () => {
      valDisplay.innerText = parseFloat(slider.value).toFixed(2);
    };

    sliderContainer.appendChild(slider);
    sliderContainer.appendChild(valDisplay);

    div.appendChild(checkbox);
    div.appendChild(label);
    div.appendChild(sliderContainer);

    // Store references for saving
    div.dataset.key = key;
    div.dataset.type = "transparency-rule";

    panel.appendChild(div);
  });
}

document
  .getElementById("btn-save-transparency")
  .addEventListener("click", () => {
    const items = document.querySelectorAll("#transparencyPanel .control-item");
    const newRules = {};

    items.forEach((item) => {
      const key = item.dataset.key;
      const checkbox = item.querySelector("input[type='checkbox']");
      const slider = item.querySelector("input[type='range']");

      if (checkbox.checked) {
        newRules[key] = parseFloat(slider.value);
      }
    });

    vscode.postMessage({
      command: "updateTransparencyRules",
      rules: newRules,
    });
  });

console.log("Settings Webview Loaded");
if (window.themeCompatibilityState) renderCompatibilityStatus(window.themeCompatibilityState);
renderGeneralSettings(); // Render general settings immediately
fetch(SERVER_ROOT + "/project.json")
  .then((res) => res.json())
  .then((json) => { window.lastWallpaperProject = json; renderUI(json); })
  .catch(
    (e) =>
      (document.getElementById("propsPanel").innerText = "Error: " + e.message)
  );

// Initial Render
renderTransparencyRules();
