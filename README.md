<div align="center">

# OpenCode in Chrome

**Пусть твой локальный агент opencode видит и управляет браузером — вкладки, клики, JS, скриншоты.**

[![GitHub stars](https://img.shields.io/github/stars/Mukller/opencode-chrome)](https://github.com/Mukller/opencode-chrome/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0-blue)](releases)

**[Anton Petnitsky](https://antonpetnitsky.com)** · [github.com/Mukller](https://github.com/Mukller) · [LinkedIn](https://www.linkedin.com/in/anton-petnitsky/)

</div>

---

Альтернатива Claude-in-Chrome для [opencode](https://opencode.ai): расширение Chrome + локальный мост с MCP-интерфейсом. Агент получает полноценный контроль над **твоим живым браузером** — с залогиненными сессиями, без `--remote-debugging-port` и без облаков. Всё через localhost.

```
┌──────────────────┐   WebSocket    ┌─────────────────┐    stdio/MCP    ┌──────────┐
│ Chrome extension │◄──────────────►│  bridge (Node)  │◄───────────────►│ opencode │
│  chrome.debugger │  127.0.0.1     │  ws + mcp       │                 │          │
└──────────────────┘                └─────────────────┘                 └──────────┘
```

Ключевой трюк: расширение само поднимает CDP-сессию через `chrome.debugger` — поэтому не нужны флаги запуска браузера, и работают все профили и куки как обычно.

## Возможности

| Инструмент MCP | Что делает |
|---|---|
| `chrome_tabs_list` | список открытых вкладок |
| `chrome_tab_open` / `_navigate` / `_close` | открыть/перейти/закрыть вкладку |
| `chrome_tab_wait_load` | дождаться загрузки страницы |
| `chrome_eval` | выполнить JavaScript на странице, получить результат |
| `chrome_click` | клик по CSS-селектору |
| `chrome_fill` | заполнить поле (React-friendly, через native setter) |
| `chrome_press_key` | отправить клавишу сфокусированному элементу |
| `chrome_read` | заголовок + URL + видимый текст страницы |
| `chrome_screenshot` | PNG-скриншот вкладки (возвращается как image-блок) |
| `chrome_console` | последние console.log / исключения страницы |

## Установка

### 1. Мост

```bash
git clone https://github.com/Mukller/opencode-chrome.git
cd opencode-chrome
npm install
node bridge/bridge.mjs
```

При первом старте мост напечатает токен и сохранит его в `~/.opencode-chrome/token`.

### 2. Расширение

1. Открой `chrome://extensions` → включи **Режим разработчика**
2. **Загрузить распакованное расширение** → выбери папку `extension/`
3. Кликни по иконке расширения → **Settings** → вставь токен из шага 1 → Save & reconnect
4. Бейдж иконки должен стать зелёным **ON**

### 3. Подключить к opencode

В `~/.config/opencode/opencode.json` (или в проектном):

```json
{
  "mcp": {
    "chrome": {
      "type": "local",
      "command": ["node", "<путь до репо>/bridge/bridge.mjs"],
      "enabled": true
    }
  }
}
```

Перезапусти opencode — инструменты `chrome_*` появятся у агента.

Переменные окружения моста: `OPENCODE_CHROME_PORT` (по умолчанию 8766), `OPENCODE_CHROME_TOKEN` (фиксированный токен вместо файла).

## Безопасность

- WS-сервер слушает **только 127.0.0.1**, чужие соединения отклоняются.
- Рукопожатие требует токен; неверный токен = соединение закрывается.
- Расширение выполняет команды только от подключённого моста; всё видно в жёлтой плашке «начата отладка» во время активных операций.

## Известные ограничения

- Пока активна CDP-сессия на вкладке, Chrome показывает инфобар «Расширение начало отладку этого браузера» — это плата за доступ без devtools-флагов.
- Service worker расширения засыпает при простое Chrome; мост просто ждёт переподключения (авто-reconnect).

## Тесты

```bash
npm test        # E2E: фейковое расширение + MCP-клиент против реального моста
```

## Лицензия

MIT © [Anton Petnitsky](https://antonpetnitsky.com)
