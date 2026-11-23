# voice-ext-inference

Qwen ASR 1.7B · Rig GPU

## Выбор микрофона / Choose a microphone

Нажмите **▾** рядом с микрофоном в поле ввода и выберите устройство по названию. Текущий выбор отмечен галочкой. Если названий пока нет, нажмите **Показать названия микрофонов** и разрешите доступ: диктовка при этом не начнётся.

Выбор запоминается отдельно в каждом браузере, включая DSH Desktop. Он применяется при обычном клике, записи с удержанием и диктовке ответов на вопросы. Если выбранный микрофон недоступен, запись не начнётся и плагин не переключится на другой. Для возврата к системному устройству выберите **Системный по умолчанию**.

Open **▾** next to the microphone and select an input by name. If names are hidden, **Show microphone names** requests access without starting dictation. The choice is kept in this browser and applies to click, hold-to-talk and question inputs. Selecting a specific device never falls back to another device. Choose **System default** to switch back to the browser’s usual input.

Device labels and the microphone preference stay in the browser and do not go to the recognition server.

## Удержание кнопки «Отправить» / Hold Send

На сенсорном экране движение в пределах 15% короткой стороны видимой области от точки первого касания не прерывает запись. Если отвести палец дальше, текущая запись отменяется, а её промежуточный текст удаляется из черновика, пока он не был отредактирован вручную. Удержание оставляет клавиатуру в исходном состоянии. Распознавание во время записи и полоса уровня звука сохраняются.

С Polaris можно записывать до 4 минут за раз. По достижении лимита появляется короткая подсветка и уведомление, а весь записанный фрагмент распознаётся без автоматической отправки сообщения. Если итоговый запрос не удался, можно повторить распознавание без повторной диктовки.

Остановка записи дожидается текущего промежуточного запроса. Если Polaris не отдаёт итог из-за пустого окна, плагин повторно распознаёт те же аудиоокна по порядку и сохраняет полученный текст. Окна, в которых модель не смогла подтвердить наличие или отсутствие речи, требуют проверки черновика перед отправкой. При другой ошибке можно повторить финальное распознавание прямо из строки состояния: запись не нужно делать заново.

## UI Zoom

The picker uses UI Zoom’s published CSS variables: the fixed panel uses viewport coordinates, while the controls inside follow the selected interface scale. The list scrolls within the available space. UI Zoom is optional; without it, both factors default to 1.

## Build

Run `node build.mjs` in the package directory to verify the packaged Client artifact. There are no install scripts.

## Настройка на новой машине

После установки строка выключена. В приватном профиле укажите адрес через `rig.peer.ip` (IPv4 в Tailnet) и `rig.peer.port` (по умолчанию `8081`). `rig.peer.peer_id` и `rig.peer.public_key` должны совпадать с тем же узлом в Tailscale. `rig.secretFile` — абсолютный путь к локальному файлу с токеном, доступному только владельцу; сам токен не является полем конфигурации. Укажите также проверенные локальные ffmpeg/Tailscale и их SHA-256. Затем включите строку, используя [пример настроек](rig.example.yml).

Плагин не обращается к серверу при отсутствии корректного адреса или несовпадении идентификатора узла, публичного ключа или адреса. Аудио отправляется только настроенному узлу. Установка не разворачивает Rig ASR, модели или локальный ASR-worker.
