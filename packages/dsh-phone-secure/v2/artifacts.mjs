import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import QRCode from 'qrcode';

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const fingerprint = value => String(value ?? '').replaceAll(':', '').match(/.{1,2}/g)?.join(':') ?? '';
const page = body => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'"><title>Подключение к DSH</title><style>
body{font:18px/1.5 system-ui,sans-serif;max-width:760px;margin:28px auto;padding:0 20px;color:#243345;background:#f6f8fb}h1{font-size:28px}h2{font-size:22px}a.button{display:block;padding:14px 18px;margin:16px 0;background:#315d97;color:white;text-decoration:none;border-radius:10px}aside{padding:12px 16px;background:#fff0d6;border-left:4px solid #b67722}img{max-width:100%;height:auto}code{overflow-wrap:anywhere;font-size:15px}small{color:#526275}li{margin:8px 0}.ok{color:#286744}
</style></head><body>${body}</body></html>`;

function caInstructions(authority) {
  return `<h2>Один раз: доверие сертификату</h2>
<p>На телефон передаётся <strong>только открытый сертификат нашего ЦС</strong>. Его приватный ключ остаётся в защищённом хранилище Windows и не включён в этот документ.</p>
<aside>Доверенный ЦС может подписывать сертификаты и для других сайтов. Не распространяйте его и удалите его из пользовательских доверенных сертификатов Android, когда функция больше не нужна. Никогда не передавайте приватный ключ ЦС.</aside>
<p>До первого HTTPS-входа передайте <strong>только открытый сертификат</strong> на телефон: через USB, Bluetooth или скачайте его из текущего чата, пока прежнее подключение ещё работает. Не используйте для передачи секретную страницу/QR через посторонний сервис. При передаче по HTTP обязательно сравните SHA-256 с экраном ноутбука.</p>
<p><a href="phone-root-ca.cer" download>Скачать корневой сертификат ЦС</a></p>
<ol><li>На Android найдите в настройках «Установить сертификат» → <strong>«Сертификат ЦС»</strong>. Раздел обычно находится в настройках безопасности / шифрования и учётных данных. Названия зависят от телефона.</li><li>Выберите сохранённый сертификат. Предупреждение об отслеживании сети относится к полномочиям добавляемого ЦС: устанавливайте только наш проверенный сертификат.</li><li>При передаче по незащищённому каналу сравните SHA-256 с показанным на ноутбуке. Не устанавливайте файл с другим отпечатком.</li></ol>
<p>SHA-256: <code>${escape(fingerprint(authority.fingerprint256))}</code></p>
<p><small>Обновление серверного сертификата или смена IP не требуют повторной установки ЦС. Повторное доверие потребуется при замене/истечении самого корневого сертификата или сбросе настроек телефона. Этот ЦС не должен распространяться другим людям.</small></p>`;
}

export async function writeConnectionArtifacts({ outputDir, publicOrigin, phoneUrl, localUrl, network, authority }) {
  const dir = resolve(outputDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const qr = await QRCode.toBuffer(phoneUrl, { type: 'png', errorCorrectionLevel: 'M', margin: 4, width: 560 });
  await writeFile(join(dir, 'phone-https-qr.png'), qr, { mode: 0o600 });
  const html = page(`<h1>DSH: защищённый вход с телефона</h1>
<p class="ok"><strong>HTTPS готов.</strong> Сеть: ${escape(network.interfaceAlias)}; адрес: <code>${escape(publicOrigin)}/</code>.</p>
<aside><strong>QR-код и ссылки содержат секрет полного доступа к DSH.</strong> Не пересылайте их другим. До входа шлюз намеренно не показывает страницу авторизации и ошибки.</aside>
${caInstructions(authority)}
<h2>Вход с телефона</h2><ol><li>Телефон должен иметь маршрут к IP выбранного адаптера: через локальную сеть, VPN или другую разрешённую сеть. Проверьте брандмауэр и правила VPN; loopback 127.* доступен только с компьютера. Сначала установите сертификат ЦС по инструкции выше.</li><li>Считайте QR-код камерой. Если встроенное окно сканера не открывает DSH, выберите «Копировать ссылку» и вставьте <strong>всю ссылку с <code>?token=…</code></strong> в новую вкладку Chrome.</li><li>После входа сохраните открывшуюся страницу в закладки: браузер запомнит штатную cookie DSH.</li></ol>
<img src="phone-https-qr.png" width="560" height="560" alt="Секретный QR-код входа в DSH по HTTPS">
<p><a id="phone-link" href="${escape(phoneUrl)}" rel="noreferrer">Секретная HTTPS-ссылка для телефона</a></p>
<h2>На ноутбуке</h2><a class="button" id="local-link" href="${escape(localUrl)}" rel="noreferrer">Открыть DSH в браузере ноутбука</a>
<h2>Если не открывается</h2><ul><li><strong>Ошибка сертификата:</strong> проверьте, что установлен именно наш ЦС, время телефона корректно, а ссылка соответствует текущему адресу. Не обходите предупреждение вслепую.</li><li><strong>Долгое ожидание:</strong> неверный или отсутствующий токен/cookie специально не получает HTTP-ответа. Откройте актуальный документ на ноутбуке и повторите вход по полной QR-ссылке.</li><li><strong>Смена Wi-Fi:</strong> адрес и QR на ноутбуке обновляются автоматически; уже открытую локальную страницу нужно обновить или открыть заново. Cookie со старого IP не переносится на новый; первый вход выполните по обновлённому QR. Сам сертификат ЦС переустанавливать не нужно.</li><li><strong>Нет соединения:</strong> ноутбук не должен спать; DSH должен быть запущен. Проверьте правило брандмауэра, отсутствие гостевой изоляции и разрешение локальной сети в VPN.</li></ul>
<p><small>Обновлено: ${escape(new Date().toLocaleString('ru-RU'))}. Шлюз не делает порт невидимым для TCP/TLS. Собственная ошибка тайм-аута Chrome и старые данные его кеша не являются ответами DSH.</small></p>
<p>Отключение: выключите весь набор <strong>«Защищённый доступ с телефона»</strong> (<code>@local/dsh-phone-secure</code>) в управлении плагинами.</p>`);
  await writeFile(join(dir, 'connect.html'), html, { encoding: 'utf8', mode: 0o600 });
}

export async function writeStandbyArtifacts({ outputDir, authority, reason = 'У выбранного адаптера нет доступного IPv4. Выбор сохранён, сетевой вход ожидает адреса.' }) {
  const dir = resolve(outputDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, 'connect.html'), page(`<h1>DSH: сетевой вход не открыт</h1><p>${escape(reason)}</p>${authority ? caInstructions(authority) : ''}<p>Desktop на ноутбуке продолжает работать через localhost.</p>`), { encoding: 'utf8', mode: 0o600 });
  const qr = await QRCode.toBuffer('Secure phone access is not active', { type: 'png', margin: 4, width: 560 });
  await writeFile(join(dir, 'phone-https-qr.png'), qr, { mode: 0o600 });
}

export async function writeGatewayStatus(outputDir, value) {
  await writeFile(join(resolve(outputDir), 'gateway-status.json'), JSON.stringify({ ...value, updatedAt: new Date().toISOString() }, null, 2), { encoding: 'utf8', mode: 0o600 });
}
