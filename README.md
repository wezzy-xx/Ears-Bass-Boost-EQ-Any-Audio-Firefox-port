# Ears-Bass-Boost-EQ-Any-Audio-Firefox-port
This is an unofficial community port of **[Ears: Bass Boost, EQ Any Audio!](https://chrome.google.com/webstore/detail/ears-audio-toolkit/nfdfiepdkbnoanddpianalelglmfooik)** by Kevin King to **Firefox**. It is based on a community fork of the Chrome extension.
Структура репозитория // Repository layout
```
manifest.json     Манифест MV3 для Firefox // Firefox MV3 manifest
bg.js             Event page: хранилище, пресеты, вкладки, внедрение скриптов // Event page: storage, presets, tabs, script injection
main.js           Аудио-движок в мире страницы: цепочка EQ, перехват Web Audio, работа с media-элементами // Audio engine in the page's world: EQ chain, Web Audio interception, media hooking
content.js        Мост между расширением и main.js // Bridge between the extension and main.js
ff-shim.js        Обход ограничения Firefox для попапа (Import Presets) // Firefox popup workaround (Import Presets)
popup.html        Разметка интерфейса попапа // Popup UI markup
popup.js          Логика попапа (отрисовка графика EQ, перетаскивание, обмен сообщениями) // Popup UI logic (EQ graph rendering, drag handling, messaging)
popup.css         Стили попапа (перенесено из оригинала — не менялось) // Popup styling  (carried over from the original — not modified)
snap.svg-min.js   Snap.svg 0.4.1 (Adobe, Apache-2.0), без изменений, рисует график EQ // Snap.svg 0.4.1 (Adobe, Apache-2.0), unmodified, draws the EQ graph
ears*.png         Иконки (перенесено из оригинала — не менялось) // Toolbar/store icons  (carried over from the original — not modified)
```
