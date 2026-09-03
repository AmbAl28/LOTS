# Публикация Crooked Mirror на Firebase Hosting

Проект уже настроен (файлы `firebase.json`, `.firebaserc`, `package.json` лежат в корне папки).
Нужно сделать ровно 4 шага.

---

## 0. Предусловия (один раз)

```bash
# Node.js ≥ 18 (у вас, скорее всего, уже есть — проверить):
node -v

# Firebase CLI:
npm install -g firebase-tools

# Логин под своим Google-аккаунтом (откроется браузер):
firebase login
```

Если глобальная установка нежелательна — заменяйте `firebase …` на `npx firebase-tools …`.

## 1. Создать проект в консоли Firebase

1. Откройте <https://console.firebase.google.com/>
2. **«Добавить проект»** → название, например `crooked-mirror`
   (Google Analytics для веб-приложения не нужен — отключите).
3. Проект создастся мгновенно. **Скопируйте id проекта** из шапки консоли
   (выглядит как `crooked-mirror-3f7a2` — id уникален, ваше числовое окончирование другое).

> Альтернатива из терминала: `firebase projects:create crooked-mirror --display-name "Crooked Mirror"`.

## 2. Прописать id в проект

В файле **`.firebaserc`** замените placeholder:

```json
{
  "projects": {
    "default": "ВАШ-ID-ПРОЕКТА"
  }
}
```

(или выполните в корне папки проекта: `firebase use --add` → выберите проект → назовите `default`).

## 3. Задеплоить

```bash
cd <папка-с-index.html>     # там, где лежит firebase.json
npm run deploy               # == firebase deploy --only hosting
```

Что произойдёт:
- поднимется статический сайт из этой папки;
- `test-pw/`, `test-media/`, `README.md`, `package.json`, dot-файлы **не** попадут на хостинг
  (это прописано в `firebase.json` → `hosting.ignore`);
- `vendor/` (~27 МБ: wasm-движок MediaPipe + модель лица ~3.7 МБ) попадёт на хостинг и
  будет закеширован на неделю — это осознанно: приложение работает полностью офлайн,
  без CDN-зависимостей.

В конце выведется адрес вида:

```
✔  https://crooked-mirror-3f7a2.web.app
```

Откройте его **в обычной вкладке браузера** (не в предпросмотре IDE) — HTTPS из коробки,
значит камера и захват экрана доступны.

## 4. Проверка после выката

- [ ] при первом заходе появляется модалка политики; «Принять» — работает;
- [ ] «🎥 Камера» → лицо отслеживается (статус внизу: `лиц: 1`);
- [ ] пресет «Улыбка Чешшир» корёжит лицо; «эмодзи вместо лица» перекрывает его;
- [ ] кнопка ☰ сворачивает интерфейс (H — то же);
- [ ] «⏺ webm» скачивает запись.

## Полезные команды

```bash
firebase hosting:channel:deploy preview           # preview-канал (свой URL, для ревью)
firebase hosting:clone --repo <src> --site <dst>  # прод ← из preview (канарти/откат)
firebase open --only hosting                      # открыть дашборд хостинга
firebase apps:list --project <id>                 # домены приложения
```

### Своё домен
Консоль Firebase → **Hosting → Add custom domain**. После добавления сертификата (пара минут)
`https://mirror.вашдомен.ru` будет работать как есть — ничего в коде менять не надо.

## Частые проблемы

| Симптом | Причина / решение |
|---|---|
| `Error: Failed to authenticate` | Не сделан `firebase login` (или под другим аккаунтом). `firebase logout && firebase login`. |
| `Error: Firebase CLI requires... / No default project` | `.firebaserc` содержит placeholder — впишите id (шаг 2). |
| Камера/экран не спрашивают разрешение | Открыто по `file://` или в iframe без `allow=camera; display-capture` — открывайте сайт напрямую по https-URL. |
| Чёрный кадр при захвате | Это DRM-плеер (Кинопоиск/Netflix/…) — так работает защита браузера, не баг. Используйте файл или не-DRM источник. |
| Модель лиц не загрузилась (ошибка в статусе) | Проверьте, что `vendor/` полностью уехал на хостинг (`/vendor/face_landmarker.task` открывается). |
| Долгая первая загрузка (~27 МБ) | Одноразово: после первого визита всё в кеше браузера/Firebase CDN (заголовки настроены). |

## (опция) Автодеплой из GitHub

Создайте в репозитории `.github/workflows/deploy.yml`:

```yaml
name: Deploy to Firebase Hosting
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: firebase/actions/deploy-hosting@v1
        with:
          project_id: ${{ secrets.FIREBASE_PROJECT_ID }}
          service_account_key: ${{ secrets.FIREBASE_SA_JSON }}
          entrypoint: '.'          # папка с index.html; если проект в подпапке — укажите её
```

В секретах репозитория: `FIREBASE_PROJECT_ID` — id проекта; `FIREBASE_SA_JSON` — JSON
сервисного аккаунта (Console → Project settings → Service accounts → Generate new private key),
роль **Firebase Hosting Admin**. После этого каждый push в main — продакшн-деплой.

---

**Быстрый чек-лист:** `firebase login` → id в `.firebaserc` → `npm run deploy` → открыть
`https://<project>.web.app` и проверить пункты раздела 4.
