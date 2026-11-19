# Ears-Bass-Boost-EQ-Any-Audio-Firefox-port
This is an unofficial community port of **[Ears: Bass Boost, EQ Any Audio!](https://chrome.google.com/webstore/detail/ears-audio-toolkit/nfdfiepdkbnoanddpianalelglmfooik)** by Kevin King to **Firefox**. It is based on a community fork of the Chrome extension.

-- Что делает расширение   
Ears позволяет в реальном времени эквализировать звук любой вкладки браузера: поднять бас, приглушить резкие высокие частоты, вывести вокал вперёд — и увидеть спектр частот того, что вы слушаете. Используются биквадратные фильтры Web Audio API (полочные + пиковые), которыми управляют перетаскиваемые точки на интерактивном графике, плюс сохранение пресетов и Bass Boost в один клик.

-- Установка    
скачайте `.xpi` на странице Releases и перетащите его в окно Firefox.

-- Нужное разрешение     
Ears должен иметь доступ к страницам, звук которых вы хотите менять. В Firefox разрешение «доступ ко всем сайтам» может не выдаваться автоматически. Если звук не меняется на сайтах со своим плеером (например, Яндекс Музыка, Spotify, SoundCloud):
Откройте `about:addons` → Ears → Разрешения.
Включите Доступ к вашим данным на всех сайтах.
Перезагрузите вкладку со звуком.

-- Как пользоваться     
Откройте вкладку, звук которой хотите эквализировать, включите воспроизведение, нажмите иконку Ears и кликните EQ Current Tab.
Перетаскивайте точки на графике, чтобы менять форму эквалайзера; shift + перетаскивание точки вверх/вниз меняет ширину фильтра (Q).
Слева — ползунок общей громкости.
Сохраняйте настройки как именованный пресет или используйте готовый Bass Boost.
Переключайте Spectrum Visualizer, чтобы видеть частотный состав звука в реальном времени.
Если ничего не происходит, кликните в любое место страницы (браузер не даёт обрабатывать звук до первого клика) и откройте консоль (F12): строки, начинающиеся с `[Ears`, объясняют, что было пропущено и почему.

-- Чем порт отличается от Chrome-версии     
В Firefox нет `chrome.tabCapture` и API `offscreen`, поэтому перехватить аудиопоток вкладки со стороны расширения нельзя. Вместо этого аудио-движок работает внутри страницы:
`manifest.json` — Manifest V3 для Firefox: `background.scripts` (event page) вместо service worker, `browser_specific_settings.gecko` (ID, минимальные версии, декларация о сборе данных), скрипт `document_start` в «мире» самой страницы (`"world": "MAIN"`).
`bg.js` — фоновая event-страница. Хранит состояние (фильтры, громкость, пресеты, список активных вкладок в `browser.storage`), внедряет скрипты во вкладку по кнопке EQ Current Tab и пересылает изменения из попапа во вкладку.
`main.js` — аудио-движок в JS-мире страницы. Для страниц со своим Web Audio он перенаправляет всё, что идёт на выход контекста, через цепочку из 11 биквадратных фильтров; обычные `<audio>`/`<video>` (в том числе не добавленные на страницу, вроде `new Audio()`) направляет через собственный `AudioContext`. Здесь же живёт анализатор спектра.
`content.js` — небольшой мост между расширением и `main.js`.
`ff-shim.js` — Firefox закрывает попап, когда открывается окно выбора файла, поэтому Import Presets открывает попап в полной вкладке.
`popup.js` / `popup.html` — практически без изменений (`popup.js` только отформатирован через Prettier).

-- Структура репозитория      

| File | Description |
| :--- | :--- |
| `manifest.json` | Манифест MV3 для Firefox |
| `bg.js` | Event page: хранилище, пресеты, вкладки, внедрение скриптов |
| `main.js` | Аудио-движок в мире страницы: цепочка EQ, перехват Web Audio, работа с media-элементами |
| `content.js` | Мост между расширением и main.js |
| `ff-shim.js` | Обход ограничения Firefox для попапа (Import Presets) |
| `popup.html` | Разметка интерфейса попапа |
| `popup.js` | Логика попапа (отрисовка графика EQ, перетаскивание, обмен сообщениями) |
| `popup.css` | Стили попапа (перенесено из оригинала — не менялось) |
| `snap.svg-min.js` | Snap.svg 0.4.1 (Adobe, Apache-2.0), без изменений, рисует график EQ |
| `ears*.png` | Иконки (перенесено из оригинала — не менялось) |


-- What the Extension Does
Ears lets you equalize the audio of any browser tab in real time: boost the bass, tame harsh high frequencies, bring vocals forward—and visualize the frequency spectrum of what you are listening to. It uses Web Audio API biquad filters (shelving + peaking) controlled via draggable nodes on an interactive graph, along with preset saving and one-click Bass Boost.

-- Installation
Download the `.xpi` file from the Releases page and drag and drop it into a Firefox window.

-- Required Permissions
Ears needs access to the pages whose audio you want to modify. In Firefox, the "Access your data for all websites" permission may not be granted automatically. If the audio does not change on websites with custom players (such as Yandex Music, Spotify, or SoundCloud):
1. Open `about:addons` → **Ears** → **Permissions**.
2. Enable **Access your data for all websites**.
3. Reload the tab playing audio.

-- How to Use
Open the tab whose audio you want to equalize, start playback, click the Ears icon, and click **EQ Current Tab**. Drag the nodes on the graph to shape the equalizer curve; hold **Shift + drag** up or down on a node to adjust the filter bandwidth (Q). On the left, there is a master volume slider. Save your settings as a named preset or use the built-in **Bass Boost**. Toggle the **Spectrum Visualizer** to see the real-time frequency breakdown of the audio. 

If nothing happens, click anywhere on the page (the browser blocks audio processing until the first user interaction) and open the developer console (`F12`): log lines starting with `[Ears` explain what was skipped and why.

-- How This Port Differs from the Chrome Version
Firefox does not support `chrome.tabCapture` or the `offscreen` API, so a tab's audio stream cannot be captured from the extension side. Instead, the audio engine runs directly inside the webpage:
* **`manifest.json`** — Manifest V3 for Firefox: uses `background.scripts` (event page) instead of a service worker, `browser_specific_settings.gecko` (extension ID, minimum Firefox versions, data collection declaration), and a `document_start` content script injected into the page's execution context (`"world": "MAIN"`).
* **`bg.js`** — Background event page. Stores state (filters, volume, presets, and the list of active tabs in `browser.storage`), injects scripts into the tab when **EQ Current Tab** is clicked, and forwards changes from the popup to the tab.
* **`main.js`** — Audio engine running in the page's JS world. For pages using their own Web Audio, it routes everything sent to the context destination through a chain of 11 biquad filters; standard `<audio>`/`<video>` elements (including detached ones not added to the DOM, such as `new Audio()`) are routed through its own `AudioContext`. The spectrum analyzer also lives here.
* **`content.js`** — A lightweight bridge between the extension and `main.js`.
* **`ff-shim.js`** — Firefox automatically closes extension popups when a file picker dialog opens, so **Import Presets** opens the popup in a full browser tab instead.
* **`popup.js` / `popup.html`** — Virtually unchanged (`popup.js` was only formatted with Prettier).

-- Repository Structure

| File | Description |
| :--- | :--- |
| `manifest.json` | MV3 manifest for Firefox |
| `bg.js` | Event page: storage, presets, tabs, and script injection |
| `main.js` | Audio engine in the page world: EQ chain, Web Audio interception, and media element handling |
| `content.js` | Bridge between the extension and `main.js` |
| `ff-shim.js` | Workaround for Firefox popup closing limitation (Import Presets) |
| `popup.html` | Popup UI markup |
| `popup.js` | Popup logic (EQ graph rendering, node dragging, and messaging) |
| `popup.css` | Popup styles (ported from the original — unchanged) |
| `snap.svg-min.js` | Snap.svg 0.4.1 (Adobe, Apache-2.0), unchanged, renders the EQ graph |
| `ears*.png` | Icons (ported from the original — unchanged) |
