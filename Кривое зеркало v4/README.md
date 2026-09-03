# Crooked Mirror v4

**Crooked Mirror v4** — браузерное «кривое зеркало» для лиц. Приложение берёт видео с камеры, экрана или локального файла, находит лицо через MediaPipe FaceLandmarker и в реальном времени рисует смешные деформации через WebGL2.

Главная ссылка после деплоя на Firebase Hosting:

```text
https://crooked-mirror.web.app/
```

Проект сделан как статический сайт: бэкенда нет, сборщик не нужен, все файлы отдаются напрямую.

---

## Что умеет приложение

- Источники видео:
  - камера;
  - захват экрана/вкладки;
  - локальный видеофайл.
- Распознавание лиц офлайн в браузере через **MediaPipe FaceLandmarker**.
- WebGL2-эффекты в реальном времени.
- 27 готовых эффектов для лица:
  - Улыбка Чешшир;
  - Огромный рот;
  - Микро-голова;
  - Надутые щёки;
  - Дыра-глазницы;
  - Выпучие глаза;
  - Раздутое лицо;
  - Голова-булавка;
  - Вихрь внутри лица;
  - Губы как у рыбы;
  - Тает как воск;
  - Жуткое вытягивание;
  - Лицо-гусеница;
  - Завихрения;
  - Желе-лицо;
  - Лицо-шар;
  - Рябь по лицу;
  - Зеркальное лицо;
  - Карандашный набросок;
  - Чёрный набросок поверх лица;
  - Негатив;
  - Пиксельная мозаика;
  - Большой нос;
  - Узкая середина лица;
  - Маленькие глаза;
  - Длинный нос;
  - Восковой потёк / статичные волны.
- Эмодзи поверх лица:
  - без обрезки овалом лица;
  - с режимом «перекрыть + наклон»;
  - с режимом «перекрыть ровно»;
  - с рандомом по изменению ракурса.
- Фото вместо лица.
- Запись результата в `.webm`.
- Сохранение кадра в `.png`.
- Кнопка **↺ Сброс** для возврата к стандартному состоянию.
- Мобильная раскладка интерфейса: верхняя панель и панель настроек не должны накладываться друг на друга.

---

## Приватность

Приложение работает локально в браузере:

- видео с камеры не отправляется на сервер;
- видеофайл не загружается на сервер;
- фото для замены лица не загружается на сервер;
- точки лица и маски существуют только в памяти вкладки;
- записанный `.webm` создаётся на устройстве пользователя.

Firebase Hosting здесь используется только как статический файловый хостинг.

---

## Структура проекта

```text
Кривое зеркало v4/
  index.html                  # интерфейс, стили, модальные окна, подключение JS
  app.js                      # логика приложения: источники, эффекты, эмодзи, фото, запись
  gl.js                       # WebGL2-рендерер и GLSL-шейдеры эффектов
  faces.js                    # MediaPipe FaceLandmarker, трекинг лиц, маски, фичи лица

  vendor/                     # обязательные файлы MediaPipe, нужны в деплое
    face_landmarker.task
    vision_bundle.mjs
    tasks-vision.version
    wasm/
      vision_wasm_internal.js
      vision_wasm_internal.wasm
      vision_wasm_nosimd_internal.js
      vision_wasm_nosimd_internal.wasm

  firebase.json               # конфигурация Firebase Hosting
  .firebaserc                 # id Firebase-проекта
  package.json                # скрипты запуска/деплоя
  README.md                   # эта инструкция
  ДЕПЛОЙ-FIREBASE.md          # короткая отдельная памятка по Firebase

  test-pw/                    # Playwright-тесты, не деплоятся
  test-media/                 # тестовые материалы, не деплоятся
```

---

## Важный момент про Firebase Hosting

В этой версии используется альтернативная схема деплоя:

```json
"public": "."
```

То есть Firebase публикует файлы прямо из корня папки `Кривое зеркало v4`, а не из отдельной папки `public`.

Это удобно, потому что `index.html` ожидает соседние файлы:

```html
<script src="gl.js"></script>
<script src="faces.js"></script>
<script src="app.js"></script>
```

А код в `app.js` ожидает папку:

```text
vendor/
```

Поэтому на хостинг обязательно должны попадать:

```text
index.html
app.js
gl.js
faces.js
vendor/
```

Если на хостинге будет только `index.html`, приложение откроется визуально, но не заработает: браузер не сможет загрузить `app.js`, `gl.js`, `faces.js` и модель распознавания лица.

---

## Текущий `firebase.json`

Файл должен выглядеть так:

```json
{
  "emulators": {
    "hosting": {
      "port": 5100
    }
  },
  "hosting": {
    "site": "crooked-mirror",
    "public": ".",
    "ignore": [
      "firebase.json",
      "**/.*",
      "**/node_modules/**",
      "README.md",
      "package*.json",
      "test-pw/**",
      "test-media/**",
      "ДЕПЛОЙ-FIREBASE.md"
    ],
    "rewrites": [
      {
        "source": "**",
        "destination": "/index.html"
      }
    ]
  }
}
```

Пояснение:

- `site: "crooked-mirror"` — сайт Firebase Hosting, который открывается как `https://crooked-mirror.web.app/`.
- `public: "."` — публикуем корень текущей папки проекта.
- `ignore` — исключаем служебные и тестовые файлы, чтобы они не попадали на сайт.
- `rewrites` — все неизвестные пути возвращают `index.html`. Для этого проекта это не обязательно как для SPA-роутинга, но не мешает, потому что реальные файлы (`app.js`, `gl.js`, `vendor/...`) Firebase отдаёт напрямую, если они существуют.

---

## Локальный запуск

### Вариант 1: через Python

Из папки проекта:

```bash
cd "Кривое зеркало v4"
python3 -m http.server 8000 --bind 127.0.0.1
```

Открыть:

```text
http://localhost:8000/
```

### Вариант 2: через npm-скрипт

```bash
cd "Кривое зеркало v4"
npm run serve:local
```

Открыть:

```text
http://localhost:8000/
```

### Для Arena/preview-среды

Если нужно открыть предпросмотр через прокси, сервер должен слушать `0.0.0.0`:

```bash
npm run serve
```

или напрямую:

```bash
python3 -m http.server 8000 --bind 0.0.0.0
```

---

## Firebase: первый деплой

### 1. Установить Firebase CLI

```bash
npm install -g firebase-tools
```

Проверить:

```bash
firebase --version
```

### 2. Войти в аккаунт

```bash
firebase login
```

### 3. Проверить `.firebaserc`

Файл `.firebaserc` должен указывать на твой Firebase-проект:

```json
{
  "projects": {
    "default": "crooked-mirror-ce0ea",
    "AmbAl": "crooked-mirror-ce0ea"
  },
  "targets": {},
  "etags": {}
}
```

Здесь `crooked-mirror-ce0ea` — id Firebase-проекта.

Важно не путать:

- `projectId`: `crooked-mirror-ce0ea`;
- hosting site: `crooked-mirror`;
- адрес сайта: `https://crooked-mirror.web.app/`.

### 4. Задеплоить

Из папки проекта:

```bash
cd "Кривое зеркало v4"
firebase deploy --only hosting
```

Или через npm:

```bash
npm run deploy
```

После успешного деплоя Firebase покажет примерно:

```text
Hosting URL: https://crooked-mirror.web.app
```

---

## Проверка после деплоя

Открой:

```text
https://crooked-mirror.web.app/
```

Потом отдельно проверь, что файлы реально доступны:

```text
https://crooked-mirror.web.app/app.js
https://crooked-mirror.web.app/gl.js
https://crooked-mirror.web.app/faces.js
https://crooked-mirror.web.app/vendor/vision_bundle.mjs
https://crooked-mirror.web.app/vendor/face_landmarker.task
https://crooked-mirror.web.app/vendor/wasm/vision_wasm_internal.wasm
```

Если по адресу `/app.js` открывается HTML-страница, а не JavaScript-код — значит `app.js` не попал в деплой. Тогда проверь `firebase.json`, текущую папку запуска команды и список `ignore`.

---

## Самая частая ошибка

Ошибка:

```text
В Firebase загружен только index.html, приложение не работает
```

Причина:

```json
"public": "public"
```

и в папке `public` лежит только `index.html`.

Решения два.

### Решение А — текущее, используемое сейчас

Оставить:

```json
"public": "."
```

И запускать деплой из папки:

```bash
Кривое зеркало v4
```

### Решение Б — классическая папка public

Если захочешь вернуться к `public`, тогда в `public` нужно копировать не только `index.html`, а весь фронтенд:

```text
public/
  index.html
  app.js
  gl.js
  faces.js
  vendor/
```

И только после этого деплоить.

---

## Кастомный домен

Если стандартный домен `crooked-mirror.web.app` не нравится, можно подключить свой домен.

Firebase Console:

```text
Hosting → Add custom domain
```

Дальше Firebase попросит добавить DNS-записи у регистратора домена. После проверки домена сайт будет доступен, например, по адресу:

```text
https://mirror.example.com/
```

Важно: камера и захват экрана требуют HTTPS. Firebase Hosting автоматически выдаёт HTTPS-сертификат для `web.app` и для подключённого кастомного домена.

---

## Мобильная версия

Для телефонов добавлена отдельная CSS-раскладка:

- верхняя панель управления ограничена по высоте и прокручивается внутри себя;
- панель настроек закреплена снизу отдельной шторкой;
- статус закреплён в самом низу;
- панели больше не должны наплывать друг на друга;
- кнопка `☰` / `🪞` полностью скрывает интерфейс, если нужно освободить экран.

Если на конкретном телефоне всё равно тесно, можно пользоваться кнопкой сворачивания интерфейса или повернуть экран горизонтально.

---

## Тесты

Тесты лежат в `test-pw/` и не попадают в Firebase-деплой.

Установка и запуск:

```bash
cd "Кривое зеркало v4"
npm install
npm test
```

Или вручную:

```bash
cd test-pw
npm install
npx playwright install chromium
node e2e-v4.js
```

Тесты проверяют:

- загрузку страницы;
- consent-модалку;
- наличие основных элементов интерфейса;
- старт источника из тестового видео;
- детекцию лица;
- переключение эффектов;
- работу сброса;
- отсутствие критических JS/WebGL-ошибок.

---

## Требования браузера

Нужно:

- современный Chrome / Edge / Firefox / Safari;
- WebGL2;
- разрешение на камеру, если используется камера;
- HTTPS или `localhost` для камеры и захвата экрана.

На слабых телефонах FPS может быть ниже, особенно если включён CPU-делегат вместо GPU.

---

## Известные ограничения

- DRM-видео может давать чёрный кадр при захвате экрана. Это ограничение браузера и платформы с видео.
- На iOS/Safari поведение камеры и autoplay может отличаться от Chrome/Android.
- Если вкладка уходит в фон, браузер может снижать FPS.
- Все эффекты рассчитаны на шутливое искажение, не на точный face-swap.

---

## Мини-чеклист перед деплоем

Из папки `Кривое зеркало v4`:

```bash
ls index.html app.js gl.js faces.js
ls vendor/face_landmarker.task vendor/vision_bundle.mjs vendor/wasm/vision_wasm_internal.wasm
cat firebase.json
firebase deploy --only hosting
```

После деплоя:

```text
https://crooked-mirror.web.app/
https://crooked-mirror.web.app/app.js
https://crooked-mirror.web.app/vendor/face_landmarker.task
```

Если эти адреса открываются корректно — проект опубликован правильно.
