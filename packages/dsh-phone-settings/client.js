/* DSH 0.2.2-rc.3 Client half. This artifact needs no compiler or separate server.
 * Only the selected Settings section reads its browser-authenticated native endpoints.
 * Never log, persist, navigate to, or publish the owner launch URL or QR contents.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-phone-settings',
  factory(require) {
    'use strict';

    const NS = 'phoneAccessSettings';
    const SECTION_ID = 'phone-access';
    const STATE_PATH = '/api/phone-access-settings/state';
    const NETWORKS_PATH = '/api/phone-access-settings/networks';
    const NETWORK_PATH = '/api/phone-access-settings/network';
    const CA_PATH = '/api/phone-access-settings/ca';
    const PORT = 63819;
    const STATES = new Set(['ready', 'inactive', 'error', 'unavailable', 'starting']);
    const NETWORK_PHASES = new Set(['ready', 'standby', 'error', 'starting', 'switching', 'inactive', 'unavailable', 'disabled', 'stopped']);
    const ERROR_KEYS = Object.freeze({
      STATUS_UNAVAILABLE: 'error.status', STATUS_INVALID: 'error.status', STATUS_STALE: 'error.status',
      GATEWAY_STARTING: 'detail.starting', GATEWAY_INACTIVE: 'detail.inactive', GATEWAY_ERROR: 'error.gateway',
      CA_UNAVAILABLE: 'error.ca', CA_INVALID: 'error.ca', CERTIFICATE_EXPIRED: 'error.certificate',
      LAUNCH_UNAVAILABLE: 'error.launch', QR_UNAVAILABLE: 'error.qr', SETTINGS_CLOSED: 'error.closed',
      NETWORK_SELECTION_UNAVAILABLE: 'network.errorUnavailable', NETWORK_QUERY_FAILED: 'network.errorQuery',
      NETWORK_SELECTION_INVALID: 'network.errorSelection', NETWORK_SELECTION_SAVE_FAILED: 'network.errorSave',
      GATEWAY_UNAVAILABLE: 'network.errorGateway', EADDRINUSE: 'network.errorPort', EACCES: 'network.errorAccess',
      CERTIFICATE_OPERATION_FAILED: 'network.errorCertificate', NETWORK_SELECTION_BUSY: 'network.errorBusy',
      EADDRNOTAVAIL: 'network.errorUnavailable', IP_ADDRESS_UNAVAILABLE: 'network.errorUnavailable',
      HELPER_TIMEOUT: 'network.errorHelperTimeout', HELPER_ABORTED: 'network.outcomeUnknown',
      HELPER_FAILED: 'network.errorCertificate', HELPER_PROTOCOL: 'network.errorCertificate',
      AUTHORITY_REPAIR_REQUIRED: 'network.errorAuthority', AUTHORITY_INVALID: 'network.errorAuthority',
      AUTHORITY_EXPIRING: 'network.errorAuthority', PUBLIC_CA_MISMATCH: 'network.errorAuthority',
      PRIVATE_STATE_UNSAFE: 'network.errorSecurity', PUBLIC_DIRECTORY_UNSAFE: 'network.errorSecurity',
      LEAF_CLEANUP_REQUIRED: 'network.errorCleanup', GATEWAY_SETUP_FAILED: 'network.errorSetup',
      REQUEST_ABORTED: 'network.outcomeUnknown', REQUEST_INVALID: 'network.errorInvalid',
      METHOD_NOT_ALLOWED: 'network.errorInvalid', INTERNAL_ERROR: 'network.errorSetup',
      AUTH_REQUIRED: 'request.denied', FORBIDDEN: 'request.denied',
    });

    const en = Object.freeze({
      title: 'Phone access',
      intro: 'Use this same DSH on your Android phone through a reachable network interface. The desktop window stays unchanged.',
      'status.loading': 'Reading current connection settings…',
      'status.ready': 'Ready to connect',
      'status.inactive': 'Phone access is not ready',
      'status.starting': 'Preparing secure access…',
      'status.error': 'Secure access needs attention',
      'status.unavailable': 'Current connection is unavailable',
      'status.readFailed': 'Could not read connection settings',
      'action.refresh': 'Refresh',
      'action.refreshing': 'Refreshing…',
      'action.retry': 'Retry',
      'network.title': 'Network for phone access',
      'network.label': 'Network interface',
      'network.description': 'All interfaces are listed, including virtual, VPN, disconnected and those without a default gateway. Choose one or let DSH select automatically. Secure access always uses port 63819.',
      'network.desktopWarning': 'Apply this from the desktop DSH window when possible: switching networks may disconnect a phone that is already connected.',
      'network.auto': 'Automatic selection',
      'network.wifi': 'Wi-Fi',
      'network.ethernet': 'Ethernet',
      'network.virtual': 'Virtual',
      'network.vpn': 'VPN',
      'network.tunnel': 'Tunnel',
      'network.loopback': 'Loopback (this computer only)',
      'network.other': 'Other interface',
      'network.status': 'Status',
      'network.statusUp': 'Up',
      'network.statusDown': 'Down',
      'network.statusDisconnected': 'Disconnected',
      'network.statusDisabled': 'Disabled',
      'network.statusNotPresent': 'Not present',
      'network.statusLowerLayerDown': 'Lower layer down',
      'network.statusDormant': 'Dormant',
      'network.statusTesting': 'Testing',
      'network.statusUnknown': 'Unknown',
      'network.noIpv4': 'No usable IPv4',
      'network.notConnectable': 'Not connectable now',
      'network.reachability': 'External, public-IP or VPN connections may need firewall rules and routing. Loopback addresses (127.*) work only on this computer.',
      'network.standbyHint': 'You can apply a disconnected interface or one without IPv4. The choice stays saved, but phone connections wait until that interface has a usable IPv4 address.',
      'network.missing': 'Adapter not in inventory',
      'network.loading': 'Reading network adapters…',
      'network.refresh': 'Refresh adapters',
      'network.refreshing': 'Refreshing adapters…',
      'network.empty': 'No network interfaces were reported. Check the computer’s adapters, then refresh.',
      'network.missingHint': 'The chosen adapter is not in the current inventory. Reconnect it and refresh, or select another interface or automatic selection, then apply.',
      'network.draft': 'This choice is not applied yet. Refreshing does not discard it.',
      'network.apply': 'Apply and start',
      'network.applying': 'Applying…',
      'network.saving': 'Applying and starting… This can take up to two minutes.',
      'network.confirming': 'The connection changed. Checking the saved choice and secure gateway…',
      'network.savedChoice': 'Currently saved choice',
      'network.activeChoice': 'Currently active interface / address',
      'network.notApplied': 'The requested choice is not saved. Review the currently saved choice, then refresh or apply again.',
      'network.errorNotActive': 'The choice is saved, but a different interface is active. Refresh to check progress or apply again.',
      'network.errorNotReady': 'The choice is saved, but the gateway has not confirmed a matching active interface and address. Refresh to check before connecting.',
      'network.applied': 'Network choice applied. Secure phone access is ready.',
      'network.savedStandby': 'Network choice saved. Secure access is waiting for the chosen interface, or an automatic choice, to have an available IPv4 address.',
      'network.savedStarting': 'Network choice saved. Secure access is being prepared.',
      'network.savedNotReady': 'Network choice saved. Secure access is not ready yet; check the connection status.',
      'network.savedError': 'Network choice saved, but secure access could not start.',
      'network.outcomeUnknown': 'The connection was interrupted; the network choice may already be saved. Reconnect from the desktop DSH window and refresh to check before retrying.',
      'network.timeout': 'The network request timed out; the outcome is unknown. Refresh to check the saved choice before retrying.',
      'network.errorInvalid': 'DSH returned invalid network settings. Refresh to check the saved choice before retrying.',
      'network.errorUnavailable': 'The chosen adapter is disconnected or has no usable IPv4 address. Its saved choice is kept. Reconnect it, refresh, or apply another interface or automatic selection.',
      'network.errorQuery': 'Could not read the network interfaces. Check the computer’s network connection and refresh.',
      'network.errorSelection': 'This adapter is not in the current inventory. Refresh and choose a listed interface or automatic selection.',
      'network.errorSave': 'The network choice could not be saved. Refresh and retry.',
      'network.errorGateway': 'The secure gateway is unavailable. Check @local/dsh-phone-secure in Plugins, then retry.',
      'network.errorPort': 'Port 63819 is already in use. Stop the conflicting application, then apply again.',
      'network.errorAccess': 'Windows denied access to the secure gateway. Check permissions and security software, then retry.',
      'network.errorCertificate': 'Windows could not prepare the secure-access certificate. Check certificate permissions, then apply again.',
      'network.errorBusy': 'Another network change is still running. Wait, then refresh to check the saved choice before retrying.',
      'network.errorHelperTimeout': 'Windows certificate preparation timed out. Check certificate permissions, then refresh before retrying.',
      'network.errorAuthority': 'The root CA needs attention. Check the secure-access plugin and its certificate diagnostics before retrying; do not bypass certificate warnings.',
      'network.errorSecurity': 'The certificate directories do not meet security requirements. Check their permissions and the secure-access plugin diagnostics before retrying.',
      'network.errorCleanup': 'Windows could not safely replace the server certificate. Check certificate permissions and the secure-access plugin diagnostics before retrying.',
      'network.errorSetup': 'Secure access could not be prepared. Check the secure-access plugin and Windows certificate permissions, then refresh before retrying.',
      'detail.inactive': 'If @local/dsh-phone-secure is off, enable it in Plugins. If it is already on, give the chosen interface a usable IPv4 address or choose another interface, then refresh.',
      'detail.starting': 'Wait while the gateway selects the network and prepares its certificate. This page refreshes automatically.',
      'detail.unavailable': 'No fresh connection data is available. Check @local/dsh-phone-secure in Plugins, then refresh.',
      'error.status': 'The gateway has not provided fresh, valid connection data. Refresh after checking the secure-access plugin.',
      'error.gateway': 'The secure gateway could not start. Check its status in Plugins, then retry.',
      'error.ca': 'The root CA is unavailable or invalid. Refresh after checking the secure-access plugin.',
      'error.certificate': 'A certificate has expired. Secure phone access needs a valid certificate before it can be used.',
      'error.launch': 'The current owner sign-in link is unavailable. Refresh to request fresh connection data.',
      'error.qr': 'The current QR code is unavailable. Refresh to request fresh connection data.',
      'error.closed': 'The settings provider has stopped. Check the plugin and retry.',
      'request.failed': 'DSH could not be reached. Check the connection and retry.',
      'request.timeout': 'DSH did not respond in time. Retry when the connection is available.',
      'request.denied': 'This section requires a trusted DSH browser session. Open the original DSH window and retry.',
      'request.unavailable': 'The phone-settings provider is unavailable. Check the plugin and retry.',
      'request.invalid': 'DSH returned invalid connection data. No sign-in link is shown. Retry after checking the plugin.',
      'fact.origin': 'Phone address',
      'fact.interface': 'Computer network',
      'fact.updated': 'Data updated',
      'fact.leafExpires': 'Server certificate expires',
      'fact.caExpires': 'Root CA expires',
      'fact.unknown': 'Not available',
      'connect.title': 'Connect your phone',
      'connect.prerequisite': 'First connection? Install the Android CA below first. If it is already installed, scan the QR code now.',
      'connect.qrAlt': 'QR code containing the full owner sign-in link for DSH',
      'connect.qrHidden': 'QR code hidden',
      'connect.qrReveal': 'Double-click to show QR',
      'connect.qrHide': 'Double-click to hide QR',
      'connect.qrKeyboard': 'Or press Enter twice',
      'connect.scan': 'Scan the QR code on your phone and open the result in Chrome.',
      'connect.copy': 'Copy full sign-in link',
      'connect.copying': 'Copying…',
      'connect.copied': 'Full link copied. Paste it into a new Chrome tab on your phone.',
      'connect.copyFailed': 'Automatic copying is unavailable. Select and copy the whole link below.',
      'connect.manualLabel': 'Full sign-in link for manual copying',
      'connect.ownerWarning': 'The QR code and full link grant owner access to DSH. Do not share them, post them, or include them in screenshots.',
      'connect.sameLan': 'The phone must be able to reach the selected computer address. A shared local network usually works; guest Wi-Fi, client isolation, firewall rules or routing can block access.',
      'connect.fallback': 'If the QR scanner does not open DSH, copy the whole link, including ?token=…, and paste it into the address bar of a new Chrome tab. Do not search for it.',
      'connect.cookie': 'DSH uses its native browser cookie for up to 30 days from sign-in, with a fixed expiry, not a sliding one. This plugin adds no cookie. After expiry, scan the current QR code again.',
      'ca.title': 'Android: install the CA once',
      'ca.download': 'Download public CA certificate',
      'ca.downloading': 'Downloading certificate…',
      'ca.downloaded': 'Certificate download requested. Check your browser downloads.',
      'ca.downloadFailed': 'The certificate could not be downloaded. Refresh and retry.',
      'ca.fingerprint': 'Root CA SHA-256 fingerprint',
      'ca.unavailable': 'The public CA is not available yet. Refresh when secure access is ready.',
      'ca.stepDownload': 'Download the public CA certificate and transfer it by USB or Bluetooth, or download it here if DSH is already open on the phone. Compare SHA-256 with the laptop screen.',
      'ca.stepAndroid': 'Android Settings → Security → Encryption & credentials → Install a certificate → CA certificate. Names vary by phone.',
      'ca.stepKind': 'Choose a CA certificate, not Wi-Fi or a client certificate. Confirm Android’s system warning. If this root CA is already installed, do not install it again.',
      'ca.trustWarning': 'A trusted root CA can sign certificates for other sites too. Install it only on your own trusted phone, and remove it from trusted credentials when you no longer need this access.',
      'help.title': 'If the phone cannot connect',
      'help.network': 'When the computer’s IP address or network changes, this page updates the address and QR code automatically. Use the current QR code; the same root CA does not need to be reinstalled.',
      'help.silent': 'A wrong or missing sign-in token is intentionally silent: the connection may appear to time out. Check the full current link, including its token.',
      'help.tls': 'TLS and certificate errors remain visible in Chrome. Check that this CA is installed as a CA certificate, that its fingerprint matches, and that the phone’s date and time are correct. Do not bypass certificate warnings.',
      'help.plugins': 'Turn phone access on or off using the existing @local/dsh-phone-secure bundle in Plugins. There is no separate switch here; local desktop access is preserved.',
    });
    const ru = Object.freeze({
      title: 'Доступ с телефона',
      intro: 'Откройте этот же DSH на Android через доступный сетевой интерфейс. Окно на компьютере остаётся без изменений.',
      'status.loading': 'Получаем текущие параметры подключения…',
      'status.ready': 'Готово к подключению',
      'status.inactive': 'Доступ с телефона пока не готов',
      'status.starting': 'Готовим защищённый доступ…',
      'status.error': 'Защищённый доступ требует внимания',
      'status.unavailable': 'Текущее подключение недоступно',
      'status.readFailed': 'Не удалось получить параметры подключения',
      'action.refresh': 'Обновить',
      'action.refreshing': 'Обновляем…',
      'action.retry': 'Повторить',
      'network.title': 'Сеть для доступа с телефона',
      'network.label': 'Сетевой интерфейс',
      'network.description': 'В списке все интерфейсы, включая виртуальные, VPN, отключённые и без шлюза по умолчанию. Выберите интерфейс либо автоматический выбор. Порт защищённого доступа всегда 63819.',
      'network.desktopWarning': 'По возможности применяйте выбор из окна DSH на компьютере: смена сети может отключить уже подключённый телефон.',
      'network.auto': 'Автоматический выбор',
      'network.wifi': 'Wi-Fi',
      'network.ethernet': 'Ethernet',
      'network.virtual': 'Виртуальный',
      'network.vpn': 'VPN',
      'network.tunnel': 'Туннель',
      'network.loopback': 'Петлевой (только этот компьютер)',
      'network.other': 'Другой интерфейс',
      'network.status': 'Состояние',
      'network.statusUp': 'Подключён',
      'network.statusDown': 'Не работает',
      'network.statusDisconnected': 'Отключён',
      'network.statusDisabled': 'Выключен',
      'network.statusNotPresent': 'Отсутствует',
      'network.statusLowerLayerDown': 'Нижний уровень не работает',
      'network.statusDormant': 'Ожидание',
      'network.statusTesting': 'Проверка',
      'network.statusUnknown': 'Неизвестно',
      'network.noIpv4': 'Нет пригодного IPv4',
      'network.notConnectable': 'Сейчас подключиться нельзя',
      'network.reachability': 'Для внешнего, публичного IP или VPN могут потребоваться правила брандмауэра и маршрутизация. Петлевые адреса (127.*) доступны только на этом компьютере.',
      'network.standbyHint': 'Можно применить отключённый интерфейс или интерфейс без IPv4. Выбор сохранится, но подключение с телефона будет ждать пригодного IPv4-адреса на этом интерфейсе.',
      'network.missing': 'Адаптера нет в списке',
      'network.loading': 'Получаем список сетевых адаптеров…',
      'network.refresh': 'Обновить адаптеры',
      'network.refreshing': 'Обновляем адаптеры…',
      'network.empty': 'Компьютер не передал ни одного сетевого интерфейса. Проверьте адаптеры и обновите список.',
      'network.missingHint': 'Выбранного адаптера нет в текущем списке. Подключите его и обновите список либо выберите другой интерфейс или автоматический выбор и примените настройки.',
      'network.draft': 'Этот выбор ещё не применён. Обновление списка его не сбрасывает.',
      'network.apply': 'Применить и запустить',
      'network.applying': 'Применяем…',
      'network.saving': 'Применяем и запускаем… Это может занять до двух минут.',
      'network.confirming': 'Соединение изменилось. Проверяем сохранённый выбор и защищённый шлюз…',
      'network.savedChoice': 'Сейчас сохранено',
      'network.activeChoice': 'Активный интерфейс / адрес',
      'network.notApplied': 'Запрошенный выбор не сохранён. Проверьте текущий сохранённый выбор, затем обновите данные или примените снова.',
      'network.errorNotActive': 'Выбор сохранён, но сейчас активен другой интерфейс. Обновите данные, чтобы проверить результат, или примените снова.',
      'network.errorNotReady': 'Выбор сохранён, но шлюз пока не подтвердил совпадение активного интерфейса и адреса. Перед подключением обновите данные и проверьте результат.',
      'network.applied': 'Выбор сети применён. Защищённый доступ с телефона готов.',
      'network.savedStandby': 'Выбор сети сохранён. Защищённый доступ ожидает доступного IPv4-адреса на выбранном интерфейсе либо при автоматическом выборе.',
      'network.savedStarting': 'Выбор сети сохранён. Защищённый доступ подготавливается.',
      'network.savedNotReady': 'Выбор сети сохранён. Защищённый доступ пока не готов — проверьте состояние подключения.',
      'network.savedError': 'Выбор сети сохранён, но защищённый доступ не удалось запустить.',
      'network.outcomeUnknown': 'Соединение прервалось; выбор сети уже мог сохраниться. Откройте DSH на компьютере и обновите данные, чтобы проверить результат перед повторной попыткой.',
      'network.timeout': 'Время ожидания сети истекло; результат неизвестен. Перед повторной попыткой обновите данные и проверьте сохранённый выбор.',
      'network.errorInvalid': 'DSH вернул некорректные настройки сети. Перед повторной попыткой обновите данные и проверьте сохранённый выбор.',
      'network.errorUnavailable': 'Выбранный адаптер отключён или не имеет пригодного IPv4-адреса. Сохранённый выбор остаётся. Подключите адаптер, обновите список либо примените другой интерфейс или автоматический выбор.',
      'network.errorQuery': 'Не удалось получить сетевые интерфейсы. Проверьте подключение компьютера и обновите список.',
      'network.errorSelection': 'Этого адаптера нет в текущем списке. Обновите список и выберите один из интерфейсов или автоматический выбор.',
      'network.errorSave': 'Не удалось сохранить выбор сети. Обновите данные и повторите попытку.',
      'network.errorGateway': 'Защищённый шлюз недоступен. Проверьте @local/dsh-phone-secure в «Плагинах» и повторите попытку.',
      'network.errorPort': 'Порт 63819 уже занят. Остановите конфликтующее приложение и примените настройки снова.',
      'network.errorAccess': 'Windows отказала в доступе защищённому шлюзу. Проверьте разрешения и защитные программы, затем повторите попытку.',
      'network.errorCertificate': 'Windows не смогла подготовить сертификат защищённого доступа. Проверьте разрешения для сертификатов и примените настройки снова.',
      'network.errorBusy': 'Другая смена сети ещё выполняется. Подождите и обновите данные, чтобы проверить сохранённый выбор перед повторной попыткой.',
      'network.errorHelperTimeout': 'Время подготовки сертификата Windows истекло. Проверьте разрешения для сертификатов и обновите данные перед повторной попыткой.',
      'network.errorAuthority': 'Корневой CA требует внимания. Проверьте плагин защищённого доступа и диагностику сертификатов перед повторной попыткой; не обходите предупреждения сертификата.',
      'network.errorSecurity': 'Каталоги сертификатов не отвечают требованиям безопасности. Проверьте их разрешения и диагностику плагина защищённого доступа перед повторной попыткой.',
      'network.errorCleanup': 'Windows не смогла безопасно заменить сертификат сервера. Проверьте разрешения для сертификатов и диагностику плагина защищённого доступа перед повторной попыткой.',
      'network.errorSetup': 'Не удалось подготовить защищённый доступ. Проверьте плагин защищённого доступа и разрешения для сертификатов Windows, затем обновите данные перед повторной попыткой.',
      'detail.inactive': 'Если @local/dsh-phone-secure выключен, включите его в «Плагинах». Если он уже включён, назначьте выбранному интерфейсу пригодный IPv4-адрес или выберите другой интерфейс, затем обновите данные.',
      'detail.starting': 'Подождите, пока шлюз выберет сеть и подготовит сертификат. Этот раздел обновляется автоматически.',
      'detail.unavailable': 'Актуальных данных подключения пока нет. Проверьте @local/dsh-phone-secure в «Плагинах» и обновите данные.',
      'error.status': 'Шлюз не передал актуальные корректные данные подключения. Проверьте плагин защищённого доступа и обновите данные.',
      'error.gateway': 'Защищённый шлюз не смог запуститься. Проверьте его состояние в «Плагинах» и повторите попытку.',
      'error.ca': 'Корневой CA недоступен или некорректен. Проверьте плагин защищённого доступа и обновите данные.',
      'error.certificate': 'Срок сертификата истёк. Для защищённого доступа с телефона нужен действующий сертификат.',
      'error.launch': 'Текущая ссылка входа владельца недоступна. Обновите параметры подключения.',
      'error.qr': 'Текущий QR-код недоступен. Обновите параметры подключения.',
      'error.closed': 'Провайдер настроек остановлен. Проверьте плагин и повторите попытку.',
      'request.failed': 'Не удалось связаться с DSH. Проверьте подключение и повторите попытку.',
      'request.timeout': 'DSH не ответил вовремя. Повторите попытку, когда подключение восстановится.',
      'request.denied': 'Для этого раздела нужен доверенный браузерный сеанс DSH. Откройте исходное окно DSH и повторите попытку.',
      'request.unavailable': 'Провайдер настроек телефона недоступен. Проверьте плагин и повторите попытку.',
      'request.invalid': 'DSH вернул некорректные данные подключения. Ссылка входа скрыта. Проверьте плагин и повторите попытку.',
      'fact.origin': 'Адрес для телефона',
      'fact.interface': 'Сеть компьютера',
      'fact.updated': 'Данные обновлены',
      'fact.leafExpires': 'Сертификат сервера действует до',
      'fact.caExpires': 'Корневой CA действует до',
      'fact.unknown': 'Пока нет данных',
      'connect.title': 'Подключить телефон',
      'connect.prerequisite': 'Подключаетесь впервые? Сначала установите CA по инструкции ниже. Если он уже установлен, сразу сканируйте QR-код.',
      'connect.qrAlt': 'QR-код с полной ссылкой входа владельца в DSH',
      'connect.qrHidden': 'QR-код скрыт',
      'connect.qrReveal': 'Двойной клик — показать QR',
      'connect.qrHide': 'Двойной клик — скрыть QR',
      'connect.qrKeyboard': 'Или дважды нажмите Enter',
      'connect.scan': 'Отсканируйте QR-код на телефоне и откройте результат в Chrome.',
      'connect.copy': 'Скопировать полную ссылку входа',
      'connect.copying': 'Копируем…',
      'connect.copied': 'Полная ссылка скопирована. Вставьте её в новую вкладку Chrome на телефоне.',
      'connect.copyFailed': 'Автоматическое копирование недоступно. Выделите и скопируйте всю ссылку из поля ниже.',
      'connect.manualLabel': 'Полная ссылка входа для ручного копирования',
      'connect.ownerWarning': 'QR-код и полная ссылка дают права владельца DSH. Не передавайте их другим, не публикуйте и не включайте в снимки экрана.',
      'connect.sameLan': 'Телефону нужен доступ к выбранному адресу компьютера. Обычно подходит общая локальная сеть; гостевой Wi-Fi, изоляция клиентов, брандмауэр или маршрутизация могут блокировать подключение.',
      'connect.fallback': 'Если сканер QR не открывает DSH, скопируйте ссылку целиком, включая ?token=…, и вставьте её в адресную строку новой вкладки Chrome. Не отправляйте её в поиск.',
      'connect.cookie': 'DSH использует свой штатный браузерный cookie до 30 дней с момента входа: срок абсолютный, не продлевается при использовании. Этот плагин не добавляет cookie. После истечения срока снова отсканируйте актуальный QR-код.',
      'ca.title': 'Android: установить CA один раз',
      'ca.download': 'Скачать публичный сертификат CA',
      'ca.downloading': 'Скачиваем сертификат…',
      'ca.downloaded': 'Скачивание сертификата запрошено. Проверьте загрузки браузера.',
      'ca.downloadFailed': 'Не удалось скачать сертификат. Обновите данные и повторите попытку.',
      'ca.fingerprint': 'Отпечаток корневого CA — SHA-256',
      'ca.unavailable': 'Публичный CA пока недоступен. Обновите данные, когда защищённый доступ будет готов.',
      'ca.stepDownload': 'Скачайте открытый сертификат ЦС и передайте на телефон через USB или Bluetooth — либо скачайте здесь, если DSH уже открыт на телефоне. Сверьте SHA-256 с экраном ноутбука.',
      'ca.stepAndroid': 'Настройки Android → Безопасность → Шифрование и учётные данные → Установить сертификат → Сертификат ЦС (CA). Названия пунктов зависят от телефона.',
      'ca.stepKind': 'Выберите сертификат CA, не «Wi-Fi» и не клиентский сертификат. Подтвердите системное предупреждение Android. Если этот корневой CA уже установлен, повторять установку не нужно.',
      'ca.trustWarning': 'Доверенный корневой CA может подписывать сертификаты и для других сайтов. Устанавливайте его только на свой доверенный телефон и удалите из доверенных учётных данных, когда этот доступ больше не нужен.',
      'help.title': 'Если телефон не подключается',
      'help.network': 'При смене IP-адреса или сети компьютера адрес и QR-код здесь обновляются автоматически. Используйте актуальный QR-код; тот же корневой CA переустанавливать не нужно.',
      'help.silent': 'Неверный или отсутствующий токен входа намеренно не вызывает ответа: подключение может выглядеть как тайм-аут. Проверьте полную текущую ссылку вместе с токеном.',
      'help.tls': 'Ошибки TLS и сертификата остаются видны в Chrome. Проверьте установку CA именно как сертификата ЦС, совпадение отпечатка, дату и время на телефоне. Не обходите предупреждения сертификата.',
      'help.plugins': 'Включайте и выключайте доступ с телефона через существующий пакет @local/dsh-phone-secure в «Плагинах». Отдельного переключателя здесь нет; локальный доступ на компьютере сохраняется.',
    });

    function fixedError(code) {
      const error = new Error(code);
      error.code = code;
      return error;
    }
    function safeText(value, max) {
      return typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
    }
    function safeDate(value) {
      return typeof value === 'string' && value.length <= 80 && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
    }
    function cleanOrigin(value) {
      if (!safeText(value, 512)) return null;
      try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.port !== String(PORT) || url.username || url.password ||
          url.pathname !== '/' || url.search || url.hash || !isUnicastIpv4(url.hostname)) return null;
        return url.origin;
      } catch (_) { return null; }
    }
    function normalizeSnapshot(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || !STATES.has(input.state) ||
        input.port !== PORT || typeof input.caAvailable !== 'boolean') throw fixedError('INVALID_RESPONSE');
      const origin = cleanOrigin(input.origin);
      const fingerprint = typeof input.caFingerprint === 'string' ? input.caFingerprint.replace(/:/g, '') : '';
      const snapshot = {
        state: input.state, origin,
        address: isUnicastIpv4(input.address) ? input.address : null,
        port: PORT, interfaceAlias: safeText(input.interfaceAlias, 1024),
        leafNotAfter: safeDate(input.leafNotAfter),
        caFingerprint: /^[a-fA-F0-9]{64}$/.test(fingerprint) ? fingerprint.toUpperCase().match(/../g).join(':') : null,
        caNotAfter: safeDate(input.caNotAfter), caAvailable: input.caAvailable,
        errorCode: Object.prototype.hasOwnProperty.call(ERROR_KEYS, input.errorCode) ? input.errorCode : null,
        launchUrl: null, qrDataUrl: null, updatedAt: safeDate(input.updatedAt),
      };
      if (input.state === 'ready') {
        if (!origin || !safeText(input.launchUrl, 4096)) throw fixedError('INVALID_RESPONSE');
        let launch;
        try { launch = new URL(input.launchUrl); } catch (_) { throw fixedError('INVALID_RESPONSE'); }
        const params = Array.from(launch.searchParams.entries());
        if (launch.origin !== origin || launch.pathname !== '/' || launch.username || launch.password || launch.hash ||
          params.length !== 1 || params[0][0] !== 'token' || !params[0][1] || /\s/.test(params[0][1]) ||
          typeof input.qrDataUrl !== 'string' || input.qrDataUrl.length > 524288 ||
          !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(input.qrDataUrl)) throw fixedError('INVALID_RESPONSE');
        snapshot.launchUrl = input.launchUrl;
        snapshot.qrDataUrl = input.qrDataUrl;
      }
      // Non-ready responses never retain a launch secret, even if a stale server sends one.
      return Object.freeze(snapshot);
    }
    function isQrRevealed(revealedSource, source) {
      return typeof source === 'string' && source.length > 0 && revealedSource === source;
    }
    function nextQrKeyActivation(previous, time, repeat) {
      if (repeat) return { previous, activate: false };
      if (previous !== null && time >= previous && time - previous <= 600) return { previous: null, activate: true };
      return { previous: time, activate: false };
    }
    function requestErrorKey(error) {
      switch (error && error.code) {
        case 'DENIED': return 'request.denied';
        case 'UNAVAILABLE': return 'request.unavailable';
        case 'INVALID_RESPONSE': return 'request.invalid';
        case 'TIMEOUT': return 'request.timeout';
        default: return 'request.failed';
      }
    }
    function statusDetailKey(snapshot) {
      if (snapshot.errorCode && ERROR_KEYS[snapshot.errorCode]) return ERROR_KEYS[snapshot.errorCode];
      return snapshot.state === 'ready' ? null : ({ inactive: 'detail.inactive', starting: 'detail.starting',
        error: 'error.gateway', unavailable: 'detail.unavailable' })[snapshot.state];
    }

    function normalizeInterfaceGuid(value) {
      return value === '' ? '' : typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value) ? value.toLowerCase() : null;
    }
    function isUnicastIpv4(value) {
      if (typeof value !== 'string' || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return false;
      const parts = value.split('.').map(Number);
      return parts.every(part => part <= 255) && parts.join('.') === value && parts[0] > 0 && parts[0] < 224;
    }
    function knownErrorCode(value) {
      return Object.prototype.hasOwnProperty.call(ERROR_KEYS, value) ? value : null;
    }
    function normalizeNetworks(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.available !== 'boolean' ||
        normalizeInterfaceGuid(input.selectedInterfaceGuid) === null || !Array.isArray(input.adapters) || input.adapters.length > 4096 ||
        input.errorCode !== null && typeof input.errorCode !== 'string') throw fixedError('INVALID_RESPONSE');
      const seen = new Set();
      const adapters = [];
      for (const item of input.adapters) {
        // Inventory is not a connectivity filter: retain virtual/VPN, disconnected and IPv6-only interfaces too.
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const interfaceGuid = normalizeInterfaceGuid(item.interfaceGuid);
        const interfaceAlias = safeText(item.interfaceAlias, 1024);
        const kind = safeText(item.kind, 64);
        if (!interfaceGuid || !interfaceAlias || !interfaceAlias.trim() || seen.has(interfaceGuid) || !kind || !kind.trim() ||
          !Number.isSafeInteger(item.interfaceIndex) || item.interfaceIndex < 0 || item.interfaceIndex > 4294967295) continue;
        const address = isUnicastIpv4(item.address) ? item.address : null;
        const prefixLength = address && Number.isInteger(item.prefixLength) && item.prefixLength >= 0 && item.prefixLength <= 32 ? item.prefixLength : null;
        const legacy = item.available === undefined && item.status === undefined && address !== null && prefixLength !== null;
        const status = safeText(item.status, 100);
        const available = item.interfaceIndex > 0 && address !== null && (legacy || item.available === true);
        seen.add(interfaceGuid);
        adapters.push(Object.freeze({ interfaceGuid, interfaceAlias, interfaceIndex: item.interfaceIndex, kind, address, prefixLength,
          status: status && status.trim() ? status : legacy ? 'Up' : 'Unknown', available }));
      }
      return Object.freeze({ available: input.available, selectedInterfaceGuid: normalizeInterfaceGuid(input.selectedInterfaceGuid),
        adapters: Object.freeze(adapters), errorCode: input.errorCode === null ? null : knownErrorCode(input.errorCode) || 'NETWORK_QUERY_FAILED',
        // Optional fresh runtime evidence; older providers omit these fields and cannot prove readiness.
        phase: NETWORK_PHASES.has(input.phase) ? input.phase : null,
        activeInterfaceGuid: normalizeInterfaceGuid(input.activeInterfaceGuid) || null,
        activeAddress: isUnicastIpv4(input.activeAddress) ? input.activeAddress : null,
        activeOrigin: cleanOrigin(input.activeOrigin),
        gatewayErrorCode: typeof input.gatewayErrorCode === 'string' ? knownErrorCode(input.gatewayErrorCode) || 'GATEWAY_SETUP_FAILED' : null });
    }
    const NETWORK_KINDS = Object.freeze(['wifi', 'ethernet', 'virtual', 'vpn', 'tunnel', 'loopback', 'other']);
    const NETWORK_STATUS_KEYS = Object.freeze({ up: 'network.statusUp', down: 'network.statusDown',
      disconnected: 'network.statusDisconnected', disabled: 'network.statusDisabled', notpresent: 'network.statusNotPresent',
      lowerlayerdown: 'network.statusLowerLayerDown', dormant: 'network.statusDormant', testing: 'network.statusTesting', unknown: 'network.statusUnknown' });
    function networkAdapterLabel(adapter, text) {
      const kind = NETWORK_KINDS.includes(adapter.kind) ? adapter.kind : 'other';
      const statusName = adapter.status.toLowerCase().replace(/[\s_-]+/g, '');
      const status = Object.prototype.hasOwnProperty.call(NETWORK_STATUS_KEYS, statusName) ? text(NETWORK_STATUS_KEYS[statusName]) : adapter.status;
      const address = adapter.address ? `${adapter.address}${adapter.prefixLength === null ? '' : `/${adapter.prefixLength}`}` : text('network.noIpv4');
      return [adapter.interfaceAlias, text(`network.${kind}`), `${text('network.status')}: ${status}`, address,
        adapter.available ? null : text('network.notConnectable')].filter(Boolean).join(' · ');
    }
    function networkChoices(network, draftInterfaceGuid) {
      const choices = [{ value: '', adapter: null, missing: false }];
      const seen = new Set(['']);
      if (network) {
        for (const adapter of network.adapters) {
          seen.add(adapter.interfaceGuid);
          choices.push({ value: adapter.interfaceGuid, adapter, missing: false });
        }
        for (const value of [network.selectedInterfaceGuid, draftInterfaceGuid]) {
          if (value && !seen.has(value)) { seen.add(value); choices.push({ value, adapter: null, missing: true }); }
        }
      }
      return choices;
    }
    function canApplyNetwork(view) {
      return Boolean(view.network && view.network.available && !view.pending && !view.saving && !view.readErrorKey &&
        (view.draftInterfaceGuid === '' || view.network.adapters.some(adapter => adapter.interfaceGuid === view.draftInterfaceGuid)));
    }
    function networkErrorKey(error, fallback = 'network.errorQuery') {
      const code = error && error.code;
      if (knownErrorCode(code)) return ERROR_KEYS[code];
      switch (code) {
        case 'DENIED': return 'request.denied';
        case 'UNAVAILABLE': return 'network.errorGateway';
        case 'INVALID_RESPONSE': return 'network.errorInvalid';
        case 'TIMEOUT': return 'network.timeout';
        default: return fallback;
      }
    }
    function networkReadErrorKey(error) {
      if (error && error.code === 'TIMEOUT') return 'request.timeout';
      return error && ['HELPER_FAILED', 'HELPER_PROTOCOL', 'HELPER_TIMEOUT', 'HELPER_ABORTED',
        'CERTIFICATE_OPERATION_FAILED', 'REQUEST_ABORTED'].includes(error.code) ? 'network.errorQuery' : networkErrorKey(error);
    }
    function networkSelectionFeedback(result, requestedGuid) {
      const committed = result.selectedInterfaceGuid === requestedGuid && (result.ok || NETWORK_PHASES.has(result.phase));
      if (committed && result.phase === 'standby') return { feedbackKey: 'network.savedStandby', saveErrorKey: null };
      if (committed && ['starting', 'switching'].includes(result.phase)) return { feedbackKey: 'network.savedStarting', saveErrorKey: null };
      if (committed && result.ok && !result.errorCode) return {
        feedbackKey: result.phase === 'ready' ? 'network.applied' : 'network.savedNotReady', saveErrorKey: null };
      const errorKey = networkErrorKey({ code: result.errorCode }, 'network.errorSetup');
      return { feedbackKey: committed ? 'network.savedError' : null,
        saveErrorKey: committed && errorKey === 'network.errorSave' ? 'network.errorSetup' : errorKey };
    }
    function networkRuntimeFeedback(network, requestedGuid) {
      if (!network.available || network.errorCode) return null;
      if (network.selectedInterfaceGuid !== requestedGuid) return { feedbackKey: null, saveErrorKey: 'network.notApplied' };
      if (network.phase === 'ready') {
        if (network.gatewayErrorCode) return networkSelectionFeedback({ ok: false, selectedInterfaceGuid: requestedGuid,
          phase: 'error', errorCode: network.gatewayErrorCode }, requestedGuid);
        if (requestedGuid !== '' && network.activeInterfaceGuid && network.activeInterfaceGuid !== requestedGuid) {
          return { feedbackKey: 'network.savedNotReady', saveErrorKey: 'network.errorNotActive' };
        }
        const active = network.adapters.find(adapter => adapter.interfaceGuid === network.activeInterfaceGuid);
        if (active && active.available === false) return { feedbackKey: 'network.savedStandby', saveErrorKey: null };
        // A saved GUID or phase alone is not endpoint proof, including automatic selection.
        if (!network.activeInterfaceGuid || !active || active.available !== true || !isUnicastIpv4(network.activeAddress) ||
          active.address !== network.activeAddress || network.activeOrigin !== `https://${network.activeAddress}:${PORT}`) {
          return { feedbackKey: 'network.savedNotReady', saveErrorKey: 'network.errorNotReady' };
        }
        return { feedbackKey: 'network.applied', saveErrorKey: null };
      }
      if (network.phase === 'standby') return { feedbackKey: 'network.savedStandby', saveErrorKey: null };
      if (['starting', 'switching'].includes(network.phase)) return { feedbackKey: 'network.savedStarting', saveErrorKey: null };
      if (network.phase === 'error') return networkSelectionFeedback({ ok: false, selectedInterfaceGuid: requestedGuid,
        phase: 'error', errorCode: network.gatewayErrorCode || 'GATEWAY_SETUP_FAILED' }, requestedGuid);
      return { feedbackKey: 'network.savedNotReady', saveErrorKey: null };
    }
    function networkFeedbackKeys(view) {
      if (view.saving) return [view.confirming ? 'network.confirming' : 'network.saving'];
      if (view.saveErrorKey) return [view.feedbackKey, view.saveErrorKey].filter(Boolean);
      if (view.pending) return ['network.loading'];
      return view.feedbackKey ? [view.feedbackKey] : view.dirty ? ['network.draft'] : [];
    }
    async function readNetworkJson(response) {
      if (response.status === 401 || response.status === 403) throw fixedError('DENIED');
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) throw fixedError('INVALID_RESPONSE');
      try { return await response.json(); } catch (_) { throw fixedError('INVALID_RESPONSE'); }
    }
    async function fetchNetworks(fetchImpl, signal) {
      const response = await fetchImpl(NETWORKS_PATH, { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: { Accept: 'application/json' }, signal });
      const data = await readNetworkJson(response);
      if (signal.aborted) throw fixedError('TIMEOUT');
      if (!response.ok) throw fixedError(knownErrorCode(data && data.errorCode) ||
        (response.status === 404 || response.status === 503 ? 'GATEWAY_UNAVAILABLE' : 'NETWORK_QUERY_FAILED'));
      return normalizeNetworks(data);
    }
    async function applyNetworkSelection(fetchImpl, interfaceGuid, signal) {
      const guid = normalizeInterfaceGuid(interfaceGuid);
      if (guid === null) throw fixedError('NETWORK_SELECTION_INVALID');
      const response = await fetchImpl(NETWORK_PATH, { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ interfaceGuid: guid }), signal });
      const data = await readNetworkJson(response);
      if (signal.aborted) throw fixedError('TIMEOUT');
      if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.ok !== 'boolean' &&
        (response.ok || data.ok !== undefined || !knownErrorCode(data.errorCode))) throw fixedError('INVALID_RESPONSE');
      const ok = data.ok === true;
      const selectedInterfaceGuid = data.selectedInterfaceGuid === undefined ? null : normalizeInterfaceGuid(data.selectedInterfaceGuid);
      const phase = safeText(data.phase, 40);
      if (data.selectedInterfaceGuid !== undefined && selectedInterfaceGuid === null) throw fixedError('INVALID_RESPONSE');
      if (ok && (!response.ok || response.status !== 200 || selectedInterfaceGuid !== guid || !phase ||
        data.errorCode !== null && typeof data.errorCode !== 'string')) throw fixedError('INVALID_RESPONSE');
      // A startup error may follow a successful persisted choice; retain that explicit committed GUID even for ok:false.
      return Object.freeze({ ok, selectedInterfaceGuid, phase,
        errorCode: data.errorCode === null && ok ? null : knownErrorCode(data.errorCode) || 'GATEWAY_SETUP_FAILED' });
    }
    function createNetworkSettings(options) {
      const schedule = options.setTimeout || setTimeout;
      const cancel = options.clearTimeout || clearTimeout;
      let mounted = false, generation = 0, reading = null, saving = null, lastRequest = null;
      const initial = () => Object.freeze({ pending: true, network: null, draftInterfaceGuid: '', dirty: false,
        saving: false, confirming: false, readErrorKey: null, saveErrorKey: null, feedbackKey: null });
      let current = initial();
      function publish(patch) {
        current = Object.freeze({ ...current, ...patch });
        if (mounted) options.onChange(current);
      }
      function publishNetwork(network, requestedGuid) {
        const draftInterfaceGuid = requestedGuid !== undefined ? requestedGuid : current.dirty ? current.draftInterfaceGuid : network.selectedInterfaceGuid;
        const feedback = lastRequest && network.phase !== null ? networkRuntimeFeedback(network, lastRequest.guid) : null;
        publish({ pending: false, network, draftInterfaceGuid, dirty: draftInterfaceGuid !== network.selectedInterfaceGuid,
          readErrorKey: network.errorCode ? networkReadErrorKey({ code: network.errorCode }) : !network.available ? 'network.errorGateway' : null,
          ...(feedback || {}) });
      }
      function abort(operation) {
        if (!operation) return;
        cancel(operation.timeout); operation.controller.abort();
        if (operation.recovery) { cancel(operation.recovery.timeout); operation.recovery.controller.abort(); }
      }
      function waitForRetry(delay, signal) {
        return new Promise(resolve => {
          let timer;
          function done() { cancel(timer); signal.removeEventListener('abort', done); resolve(); }
          timer = schedule(done, delay);
          signal.addEventListener('abort', done, { once: true });
          if (signal.aborted) done();
        });
      }
      function abortable(promise, signal) {
        return new Promise((resolve, reject) => {
          function aborted() { reject(fixedError('REQUEST_ABORTED')); }
          signal.addEventListener('abort', aborted, { once: true });
          if (signal.aborted) aborted();
          Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
        });
      }
      async function recoverSelection(operation, owner, guid) {
        const recovery = { controller: new AbortController(), timeout: null };
        operation.recovery = recovery;
        recovery.timeout = schedule(() => recovery.controller.abort(), 10000);
        let latest = null;
        try {
          // A lost POST response does not mean a failed commit. Read fresh state for at most ten more seconds.
          for (const delay of [0, 500, 1000, 2000, 3000]) {
            if (delay) await waitForRetry(delay, recovery.controller.signal);
            if (!mounted || generation !== owner || recovery.controller.signal.aborted) break;
            try {
              const network = await abortable(fetchNetworks(options.fetch, recovery.controller.signal), recovery.controller.signal);
              if (!mounted || generation !== owner || recovery.controller.signal.aborted) break;
              publishNetwork(network, guid);
              if (!network.available || network.errorCode) continue;
              latest = network;
              const feedback = networkRuntimeFeedback(network, guid);
              if (feedback.feedbackKey === 'network.applied' || network.phase === null && network.selectedInterfaceGuid === guid) return feedback;
            } catch (_) { /* Keep retrying; no server diagnostics or launch data enter feedback. */ }
          }
          return latest ? networkRuntimeFeedback(latest, guid) : null;
        } finally {
          cancel(recovery.timeout); recovery.controller.abort();
          if (operation.recovery === recovery) operation.recovery = null;
        }
      }
      function refresh() {
        if (!mounted || saving) return Promise.resolve();
        if (reading) return reading.promise;
        const owner = generation;
        const operation = { controller: new AbortController(), timeout: null, promise: null };
        let timedOut = false;
        reading = operation;
        publish({ pending: true, readErrorKey: null });
        operation.timeout = schedule(() => { timedOut = true; operation.controller.abort(); }, 10000);
        operation.promise = (async () => {
          try {
            const network = await abortable(fetchNetworks(options.fetch, operation.controller.signal), operation.controller.signal);
            if (!mounted || generation !== owner || operation.controller.signal.aborted) return;
            publishNetwork(network);
          } catch (error) {
            if (mounted && generation === owner) publish({ pending: false, readErrorKey: networkReadErrorKey(timedOut ? fixedError('TIMEOUT') : error) });
          } finally {
            cancel(operation.timeout);
            if (reading === operation) reading = null;
          }
        })();
        return operation.promise;
      }
      function applySelection() {
        if (saving) return saving.promise;
        if (!mounted || !canApplyNetwork(current)) return Promise.resolve();
        const owner = generation, guid = current.draftInterfaceGuid;
        const operation = { controller: new AbortController(), timeout: null, promise: null, recovery: null };
        let timedOut = false;
        saving = operation; lastRequest = null;
        publish({ saving: true, confirming: false, saveErrorKey: null, feedbackKey: null });
        if (options.onApplyStart) options.onApplyStart();
        operation.timeout = schedule(() => { timedOut = true; operation.controller.abort(); }, 120000);
        operation.promise = (async () => {
          try {
            const result = await applyNetworkSelection(options.fetch, guid, operation.controller.signal);
            if (!mounted || generation !== owner || operation.controller.signal.aborted) return;
            // Explicit pre-commit failures must never become success merely because the old selection was already ready.
            if (result.selectedInterfaceGuid === guid && (result.ok || NETWORK_PHASES.has(result.phase))) lastRequest = { guid };
            const network = result.selectedInterfaceGuid === null ? current.network : Object.freeze({ ...current.network,
              selectedInterfaceGuid: result.selectedInterfaceGuid });
            publish({ network, dirty: guid !== network.selectedInterfaceGuid, ...networkSelectionFeedback(result, guid) });
          } catch (error) {
            if (!mounted || generation !== owner) return;
            if (error && ['DENIED', 'NETWORK_SELECTION_INVALID'].includes(error.code)) {
              publish({ saveErrorKey: networkErrorKey(error, 'network.errorSave') });
              return;
            }
            cancel(operation.timeout); operation.timeout = null;
            lastRequest = { guid };
            publish({ confirming: true });
            const feedback = await recoverSelection(operation, owner, guid);
            if (mounted && generation === owner) publish(feedback || { feedbackKey: null,
              saveErrorKey: networkErrorKey(timedOut ? fixedError('TIMEOUT') : error, 'network.outcomeUnknown') });
          } finally {
            cancel(operation.timeout);
            if (saving === operation) saving = null;
            if (mounted && generation === owner) {
              publish({ saving: false, confirming: false });
              await Promise.all([refresh(), options.onApplySettled ? options.onApplySettled() : undefined]);
            }
          }
        })();
        return operation.promise;
      }
      return Object.freeze({
        start() { if (!mounted) { mounted = true; generation++; return refresh(); } return reading ? reading.promise : Promise.resolve(); },
        refresh, applySelection,
        choose(value) {
          const guid = normalizeInterfaceGuid(value);
          if (!mounted || !current.network || current.saving || guid === null || !networkChoices(current.network, current.draftInterfaceGuid).some(choice => choice.value === guid)) return;
          lastRequest = null;
          publish({ draftInterfaceGuid: guid, dirty: guid !== current.network.selectedInterfaceGuid, saveErrorKey: null, feedbackKey: null });
        },
        stop() {
          mounted = false; generation++;
          abort(reading); abort(saving); reading = null; saving = null; lastRequest = null;
          current = initial();
        },
      });
    }

    /* Pure lifecycle controller, also exported for focused tests. It has no browser/React side effects until start(). */
    function createSnapshotReader(options) {
      const fetchImpl = options.fetch;
      const schedule = options.setTimeout || setTimeout;
      const cancel = options.clearTimeout || clearTimeout;
      const intervalMs = options.intervalMs || 15000;
      const timeoutMs = options.timeoutMs || 10000;
      let mounted = false;
      let paused = false;
      let generation = 0;
      let pollTimer = null;
      let active = null;
      let current = Object.freeze({ pending: true, snapshot: null, errorKey: null });
      const publish = (value) => {
        current = Object.freeze(value);
        if (mounted) options.onChange(current);
      };
      function refresh() {
        if (!mounted || paused) return Promise.resolve();
        if (active) return active.promise;
        if (pollTimer !== null) { cancel(pollTimer); pollTimer = null; }
        if (options.onRefresh) options.onRefresh();
        const owner = generation;
        const controller = new AbortController();
        const operation = { controller, promise: null, timeout: null };
        let timedOut = false;
        active = operation;
        publish({ pending: true, snapshot: current.snapshot, errorKey: current.errorKey });
        operation.timeout = schedule(() => { timedOut = true; controller.abort(); }, timeoutMs);
        operation.promise = (async () => {
          try {
            const response = await fetchImpl(STATE_PATH, {
              method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
              headers: { Accept: 'application/json' }, signal: controller.signal,
            });
            if (!response.ok) throw fixedError(response.status === 401 || response.status === 403 ? 'DENIED' :
              response.status === 404 || response.status === 503 ? 'UNAVAILABLE' : 'REQUEST_FAILED');
            if (!/^(?:application\/json)(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) throw fixedError('INVALID_RESPONSE');
            let data;
            try { data = await response.json(); } catch (_) { throw fixedError('INVALID_RESPONSE'); }
            const snapshot = normalizeSnapshot(data);
            if (mounted && generation === owner && !controller.signal.aborted) publish({ pending: false, snapshot, errorKey: null });
          } catch (error) {
            if (mounted && generation === owner) publish({ pending: false, snapshot: null,
              errorKey: requestErrorKey(timedOut ? fixedError('TIMEOUT') : error) });
          } finally {
            cancel(operation.timeout);
            if (active === operation) active = null;
            if (mounted && generation === owner) pollTimer = schedule(() => { pollTimer = null; void refresh(); }, intervalMs);
          }
        })();
        return operation.promise;
      }
      return Object.freeze({
        start() { if (!mounted) { mounted = true; generation++; return refresh(); } return active ? active.promise : Promise.resolve(); },
        refresh,
        pause() {
          if (!mounted) return;
          paused = true; generation++;
          if (pollTimer !== null) { cancel(pollTimer); pollTimer = null; }
          if (active) { cancel(active.timeout); active.controller.abort(); active = null; }
          publish({ pending: true, snapshot: null, errorKey: null });
        },
        resume() { if (!mounted) return Promise.resolve(); paused = false; return refresh(); },
        stop() {
          mounted = false; paused = false; generation++;
          if (pollTimer !== null) { cancel(pollTimer); pollTimer = null; }
          if (active) { cancel(active.timeout); active.controller.abort(); active = null; }
          current = Object.freeze({ pending: true, snapshot: null, errorKey: null });
        },
      });
    }
    async function fetchCertificate(fetchImpl, signal) {
      const response = await fetchImpl(CA_PATH, {
        method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: { Accept: 'application/pkix-cert' }, signal,
      });
      if (!response.ok || !/^application\/pkix-cert(?:\s*;|$)/i.test(response.headers.get('content-type') || '') ||
        Number(response.headers.get('content-length') || 0) > 65536) throw fixedError('CA_DOWNLOAD_FAILED');
      const bytes = await response.arrayBuffer();
      if (signal.aborted || bytes.byteLength === 0 || bytes.byteLength > 65536) throw fixedError('CA_DOWNLOAD_FAILED');
      return bytes;
    }

    const CSS = `
.dsh-phone-settings{width:100%;min-width:0;box-sizing:border-box;padding:0 0 24px;color:var(--dsw-alias-label-primary);font:inherit;line-height:1.5}
.dsh-phone-settings *{box-sizing:border-box}
.dsh-phone-settings h2{font-size:18px;font-weight:500;line-height:26px;margin:0 0 8px}
.dsh-phone-settings h3{font-size:14px;font-weight:500;line-height:20px;margin:0 0 12px}
.dsh-phone-settings p{margin:0 0 12px}
.dsh-phone-settings .dps-intro,.dsh-phone-settings .dps-muted{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dsh-phone-settings .dps-section{padding:20px 0;border-bottom:0.5px solid var(--dsw-alias-border-l2)}
.dsh-phone-settings .dps-section:last-child{border-bottom:0;padding-bottom:0}
.dsh-phone-settings .dps-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:16px 0 12px}
.dsh-phone-settings .dps-status{font-size:13px;line-height:20px;min-width:0}
.dsh-phone-settings .dps-status[data-state=ready]{color:var(--dsw-alias-state-success-primary)}
.dsh-phone-settings .dps-status[data-state=error],.dsh-phone-settings .dps-error{color:var(--dsw-alias-state-error-primary)}
.dsh-phone-settings .dps-button{display:inline-flex;justify-content:center;align-items:center;gap:8px;min-height:36px;max-width:100%;padding:7px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;text-align:center;white-space:normal;cursor:pointer}
.dsh-phone-settings .dps-button-primary{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);font-weight:500}
.dsh-phone-settings .dps-button:disabled{opacity:.5;cursor:default}
.dsh-phone-settings .dps-button:focus-visible,.dsh-phone-settings textarea:focus-visible,.dsh-phone-settings select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dsh-phone-settings .dps-network-field{display:flex;flex-direction:column;gap:6px;font-size:13px;line-height:20px}
.dsh-phone-settings .dps-network-select{display:block;width:100%;min-width:0;min-height:36px;padding:7px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;text-overflow:ellipsis}
.dsh-phone-settings .dps-network-select:disabled{opacity:.5}
.dsh-phone-settings .dps-network-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.dsh-phone-settings .dps-success{color:var(--dsw-alias-state-success-primary)}
.dsh-phone-settings .dps-facts{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.4fr);gap:8px 16px;margin:16px 0 0;font-size:12px;line-height:18px}
.dsh-phone-settings .dps-facts dt{color:var(--dsw-alias-label-secondary)}
.dsh-phone-settings .dps-facts dd{margin:0;min-width:0;overflow-wrap:anywhere}
.dsh-phone-settings .dps-connect{display:flex;flex-wrap:wrap;align-items:flex-start;gap:20px}
.dsh-phone-settings .dps-qr-private{flex:0 1 224px;width:224px;max-width:100%;margin:0 auto}
.dsh-phone-settings .dps-qr-guard{position:relative;display:block;width:100%;aspect-ratio:1;padding:0;overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;touch-action:manipulation;user-select:none}
.dsh-phone-settings .dps-qr-guard:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}
.dsh-phone-settings .dps-qr{display:block;width:100%;max-width:100%;height:auto;aspect-ratio:1;object-fit:contain;image-rendering:pixelated;pointer-events:none}
.dsh-phone-settings .dps-qr-decoy{position:absolute;inset:10px;background:repeating-conic-gradient(var(--dsw-alias-label-primary) 0 25%,var(--dsw-alias-bg-layer-2) 0 50%);background-size:18px 18px;filter:blur(9px);opacity:.35;pointer-events:none}
.dsh-phone-settings .dps-qr-cover{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:12px;font-size:14px;font-weight:500;pointer-events:none}
.dsh-phone-settings .dps-qr-hint{margin:8px 0 0!important;font-size:12px;line-height:18px;text-align:center;color:var(--dsw-alias-label-secondary)}
.dsh-phone-settings .dps-connect-copy{flex:1 1 180px;min-width:0;font-size:13px;line-height:20px}
.dsh-phone-settings .dps-feedback{min-height:18px;font-size:12px;line-height:18px;margin-top:8px;overflow-wrap:anywhere}
.dsh-phone-settings .dps-warning{padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-overlay);font-size:12px;line-height:18px}
.dsh-phone-settings .dps-owner-warning{margin-top:16px}
.dsh-phone-settings ul,.dsh-phone-settings ol{margin:12px 0;padding-inline-start:20px;font-size:12px;line-height:18px}
.dsh-phone-settings li+li{margin-top:10px}
.dsh-phone-settings .dps-fingerprint{display:block;margin-top:6px;font-family:inherit;font-size:12px;line-height:18px;overflow-wrap:anywhere;user-select:text}
.dsh-phone-settings .dps-manual{display:flex;flex-direction:column;gap:6px;margin-top:12px;font-size:12px;line-height:18px}
.dsh-phone-settings textarea{display:block;width:100%;resize:vertical;min-height:80px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;line-height:20px;overflow-wrap:anywhere}
.dsh-phone-settings .dps-ca-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin-bottom:12px}
@media(hover:hover){.dsh-phone-settings .dps-button:not(:disabled):hover{background:var(--dsw-alias-bg-layer-1)}}
@media(max-width:479px){.dsh-phone-settings .dps-facts{grid-template-columns:1fr;gap:3px}.dsh-phone-settings .dps-facts dd+dt{margin-top:9px}.dsh-phone-settings .dps-connect-copy{flex-basis:100%}}
@media(pointer:coarse){.dsh-phone-settings textarea,.dsh-phone-settings select{font-size:16px}.dsh-phone-settings .dps-button,.dsh-phone-settings .dps-network-select{min-height:40px}}
`;

    function apply(ctx) {
      const React = require('react');
      const h = React.createElement;
      const { useEffect, useRef, useState } = React;
      ctx.effect(() => ctx.locale.register(NS, 'en', en), 'phone-access: English dictionary');
      ctx.effect(() => ctx.locale.register(NS, 'ru', ru), 'phone-access: Russian dictionary');
      const translate = ctx.locale.bind(NS);
      // Only the QR component is memoized: timestamps/status can update without repainting identical artwork.
      const QrImage = React.memo(function QrImage({ src, alt, hiddenLabel, revealLabel, hideLabel, keyboardLabel }) {
        const [revealedSource, setRevealedSource] = useState(null);
        const keyRef = useRef(null);
        // Identity-based visibility masks a new QR on its very first render,
        // before passive effects run. Never render the real image while hidden.
        const revealed = isQrRevealed(revealedSource, src);
        function conceal() { setRevealedSource(null); keyRef.current = null; }
        function toggle() { setRevealedSource(value => isQrRevealed(value, src) ? null : src); keyRef.current = null; }
        useEffect(() => { conceal(); }, [src]);
        useEffect(() => {
          function onVisibility() { if (document.visibilityState !== 'visible') conceal(); }
          window.addEventListener('blur', conceal);
          document.addEventListener('visibilitychange', onVisibility);
          return () => {
            window.removeEventListener('blur', conceal);
            document.removeEventListener('visibilitychange', onVisibility);
          };
        }, []);
        function onKeyDown(event) {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          const next = nextQrKeyActivation(keyRef.current, Date.now(), event.repeat);
          keyRef.current = next.previous;
          if (next.activate) toggle();
        }
        return h('div', { className: 'dps-qr-private' },
          h('button', { type: 'button', className: 'dps-qr-guard', 'aria-pressed': revealed,
            'aria-label': revealed ? hideLabel : revealLabel, 'aria-describedby': 'dps-qr-privacy-hint',
            title: `${revealed ? hideLabel : revealLabel}. ${keyboardLabel}`,
            onDoubleClick: event => { event.preventDefault(); toggle(); }, onKeyDown, onBlur: conceal },
            revealed ? h('img', { className: 'dps-qr', src, alt, width: 224, height: 224, draggable: false, referrerPolicy: 'no-referrer' }) :
              h(React.Fragment, null, h('span', { className: 'dps-qr-decoy', 'aria-hidden': true }),
                h('span', { className: 'dps-qr-cover', 'aria-hidden': true }, hiddenLabel))),
          h('p', { className: 'dps-qr-hint', id: 'dps-qr-privacy-hint' }, revealed ? hideLabel : revealLabel,
            h('br'), keyboardLabel));
      });
      function PhoneAccessSettings({ t }) {
        const [view, setView] = useState({ pending: true, snapshot: null, errorKey: null });
        const [networkView, setNetworkView] = useState({ pending: true, network: null, draftInterfaceGuid: '', dirty: false,
          saving: false, confirming: false, readErrorKey: null, saveErrorKey: null, feedbackKey: null });
        const [copyState, setCopyState] = useState('idle');
        const [downloadState, setDownloadState] = useState('idle');
        const readerRef = useRef(null);
        const networkRef = useRef(null);
        const manualRef = useRef(null);
        const downloadAnchorRef = useRef(null);
        const downloadRef = useRef(null);
        const downloadsRef = useRef(new Map());
        const mountedRef = useRef(false);
        const snapshot = networkView.saving ? null : view.snapshot;
        const launchUrl = snapshot && snapshot.state === 'ready' ? snapshot.launchUrl : null;
        const launchRef = useRef(launchUrl);
        launchRef.current = launchUrl;
        const caIdentity = snapshot ? [snapshot.caAvailable, snapshot.caFingerprint].join(':') : '';
        const locale = ctx.locale.getSnapshot().active;
        const text = t || translate;
        function dateLabel(value) {
          if (!value) return text('fact.unknown');
          try { return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
          catch (_) { return value; }
        }
        useEffect(() => {
          mountedRef.current = true;
          const fetchImpl = globalThis.fetch.bind(globalThis);
          const networks = createNetworkSettings({ fetch: fetchImpl, onChange: setNetworkView,
            onApplyStart: () => {
              reader.pause();
              launchRef.current = null;
              setCopyState('idle');
            },
            onApplySettled: () => reader.resume(),
          });
          const reader = createSnapshotReader({ fetch: fetchImpl, onChange: setView, onRefresh: () => { void networks.refresh(); } });
          readerRef.current = reader;
          networkRef.current = networks;
          void networks.start();
          void reader.start();
          return () => {
            mountedRef.current = false;
            readerRef.current = null;
            networkRef.current = null;
            networks.stop();
            reader.stop();
            if (downloadRef.current) { clearTimeout(downloadRef.current.timeout); downloadRef.current.controller.abort(); downloadRef.current = null; }
            for (const [url, timer] of downloadsRef.current) { clearTimeout(timer); URL.revokeObjectURL(url); }
            downloadsRef.current.clear();
          };
        }, []);
        useEffect(() => { setCopyState('idle'); }, [launchUrl]);
        useEffect(() => {
          setDownloadState('idle');
          if (downloadRef.current) { clearTimeout(downloadRef.current.timeout); downloadRef.current.controller.abort(); downloadRef.current = null; }
        }, [caIdentity]);
        useEffect(() => {
          if (copyState === 'manual' && launchUrl && manualRef.current) { manualRef.current.focus(); manualRef.current.select(); }
        }, [copyState, launchUrl]);
        function refreshSettings() {
          if (readerRef.current) void readerRef.current.refresh();
          if (networkRef.current) void networkRef.current.refresh();
        }
        async function copyLink() {
          if (!launchUrl || copyState === 'copying') return;
          const value = launchUrl;
          setCopyState('copying');
          try {
            if (!globalThis.navigator || !globalThis.navigator.clipboard || !globalThis.navigator.clipboard.writeText) throw fixedError('COPY_UNAVAILABLE');
            await globalThis.navigator.clipboard.writeText(value);
            if (mountedRef.current && launchRef.current === value) setCopyState('copied');
          } catch (_) {
            if (mountedRef.current && launchRef.current === value) setCopyState('manual');
          }
        }
        async function downloadCa() {
          if (!snapshot || !snapshot.caAvailable || downloadRef.current) return;
          const operation = { controller: new AbortController(), timeout: null };
          operation.timeout = setTimeout(() => operation.controller.abort(), 15000);
          downloadRef.current = operation;
          setDownloadState('downloading');
          try {
            const bytes = await fetchCertificate(globalThis.fetch.bind(globalThis), operation.controller.signal);
            if (!mountedRef.current || downloadRef.current !== operation || operation.controller.signal.aborted) return;
            const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pkix-cert' }));
            const timer = setTimeout(() => { URL.revokeObjectURL(url); downloadsRef.current.delete(url); }, 60000);
            downloadsRef.current.set(url, timer);
            const anchor = downloadAnchorRef.current;
            if (!anchor) throw fixedError('CA_DOWNLOAD_FAILED');
            anchor.href = url;
            anchor.click();
            // The DOM reference only names public CA bytes, never a launch link.
            anchor.removeAttribute('href');
            setDownloadState('downloaded');
          } catch (_) {
            if (mountedRef.current && downloadRef.current === operation) setDownloadState('failed');
          } finally {
            clearTimeout(operation.timeout);
            if (downloadRef.current === operation) downloadRef.current = null;
          }
        }
        const choices = networkChoices(networkView.network, networkView.draftInterfaceGuid);
        const missingChoice = choices.some(choice => choice.value === networkView.draftInterfaceGuid && choice.missing);
        const savedChoice = networkView.network ? choices.find(choice => choice.value === networkView.network.selectedInterfaceGuid) : null;
        const activeAdapter = networkView.network ? networkView.network.adapters.find(adapter => adapter.interfaceGuid === networkView.network.activeInterfaceGuid) : null;
        const activeLabel = networkView.network ? [activeAdapter ? activeAdapter.interfaceAlias : networkView.network.activeInterfaceGuid,
          networkView.network.activeOrigin || networkView.network.activeAddress].filter(Boolean).join(' · ') : '';
        const networkFeedback = networkFeedbackKeys(networkView);
        const refreshing = view.pending || networkView.pending;
        const state = view.errorKey ? 'error' : snapshot ? snapshot.state : 'loading';
        const detailKey = view.errorKey || (snapshot ? statusDetailKey(snapshot) : null);
        const feedbackKey = copyState === 'copied' ? 'connect.copied' : copyState === 'manual' ? 'connect.copyFailed' : null;
        const facts = [];
        function fact(key, value) { facts.push(h(React.Fragment, { key }, h('dt', null, text(key)), h('dd', null, value))); }
        if (snapshot) {
          if (snapshot.origin) fact('fact.origin', h('span', null, snapshot.origin));
          if (snapshot.interfaceAlias || snapshot.address) fact('fact.interface', [snapshot.interfaceAlias, snapshot.address].filter(Boolean).join(' · '));
          if (snapshot.updatedAt) fact('fact.updated', h('time', { dateTime: snapshot.updatedAt }, dateLabel(snapshot.updatedAt)));
          if (snapshot.leafNotAfter) fact('fact.leafExpires', h('time', { dateTime: snapshot.leafNotAfter }, dateLabel(snapshot.leafNotAfter)));
        }
        return h('section', { className: 'dsh-phone-settings' },
          h('style', null, CSS),
          h('h2', null, text('title')),
          h('p', { className: 'dps-intro' }, text('intro')),
          h('div', { className: 'dps-section', 'aria-labelledby': 'dps-network-title' },
            h('h3', { id: 'dps-network-title' }, text('network.title')),
            h('p', { className: 'dps-muted', id: 'dps-network-description' }, text('network.description')),
            h('p', { className: 'dps-muted', id: 'dps-network-warning' }, text('network.desktopWarning')),
            h('p', { className: 'dps-muted', id: 'dps-network-reachability' }, text('network.reachability')),
            h('label', { className: 'dps-network-field', htmlFor: 'dps-network-adapter' }, text('network.label'),
              h('select', { id: 'dps-network-adapter', className: 'dps-network-select', value: networkView.draftInterfaceGuid,
                disabled: !networkView.network || !networkView.network.available || networkView.saving,
                'aria-describedby': `dps-network-description dps-network-warning dps-network-reachability dps-network-standby${missingChoice ? ' dps-network-missing' : ''}`,
                onChange: event => { if (networkRef.current) networkRef.current.choose(event.currentTarget.value); } },
                choices.map(choice => h('option', { key: choice.value, value: choice.value, disabled: choice.missing },
                  choice.adapter ? networkAdapterLabel(choice.adapter, text) :
                    choice.missing ? `${text('network.missing')} · ${choice.value}` : text('network.auto'))))),
            savedChoice ? h('p', { className: 'dps-muted' }, text('network.savedChoice'), ': ',
              savedChoice.adapter ? networkAdapterLabel(savedChoice.adapter, text) : savedChoice.missing ?
                `${text('network.missing')} · ${savedChoice.value}` : text('network.auto')) : null,
            activeLabel ? h('p', { className: 'dps-muted' }, text('network.activeChoice'), ': ', activeLabel) : null,
            h('p', { className: 'dps-muted', id: 'dps-network-standby' }, text('network.standbyHint')),
            missingChoice ? h('p', { className: 'dps-muted', id: 'dps-network-missing' }, text('network.missingHint')) : null,
            networkView.network && networkView.network.available && !networkView.network.adapters.length && !networkView.pending && !networkView.readErrorKey ?
              h('p', { className: 'dps-muted' }, text('network.empty')) : null,
            h('div', { className: 'dps-network-actions' },
              h('button', { type: 'button', className: 'dps-button dps-button-primary', disabled: !canApplyNetwork(networkView),
                onClick: () => { if (networkRef.current) void networkRef.current.applySelection(); } },
                text(networkView.saving ? 'network.applying' : 'network.apply')),
              h('button', { type: 'button', className: 'dps-button', disabled: refreshing || networkView.saving, onClick: refreshSettings },
                text(networkView.pending ? 'network.refreshing' : 'network.refresh'))),
            h('div', { className: `dps-feedback${networkView.saveErrorKey ? ' dps-error' : networkView.feedbackKey === 'network.applied' && !networkView.pending && !networkView.saving ? ' dps-success' : ''}`,
              role: networkView.saveErrorKey ? 'alert' : 'status', 'aria-live': 'polite' }, networkFeedback.map(key => text(key)).join(' ')),
            networkView.readErrorKey ? h('p', { className: 'dps-error dps-muted', role: 'alert' }, text(networkView.readErrorKey)) : null),
          h('div', { className: 'dps-toolbar' },
            h('div', { className: 'dps-status', 'data-state': state, role: 'status', 'aria-live': 'polite', 'aria-busy': view.pending },
              text(view.errorKey ? 'status.readFailed' : `status.${state}`)),
            h('button', { type: 'button', className: 'dps-button', disabled: refreshing || networkView.saving, onClick: refreshSettings },
              text(refreshing ? 'action.refreshing' : view.errorKey || state === 'error' ? 'action.retry' : 'action.refresh'))),
          detailKey ? h('p', { className: view.errorKey || state === 'error' ? 'dps-error dps-muted' : 'dps-muted',
            role: view.errorKey || state === 'error' ? 'alert' : undefined }, text(detailKey)) : null,
          facts.length ? h('dl', { className: 'dps-facts' }, facts) : null,
          launchUrl ? h('div', { className: 'dps-section' },
            h('h3', null, text('connect.title')),
            h('p', { className: 'dps-muted' }, text('connect.prerequisite')),
            h('div', { className: 'dps-connect' },
              h(QrImage, { src: snapshot.qrDataUrl, alt: text('connect.qrAlt'), hiddenLabel: text('connect.qrHidden'),
                revealLabel: text('connect.qrReveal'), hideLabel: text('connect.qrHide'), keyboardLabel: text('connect.qrKeyboard') }),
              h('div', { className: 'dps-connect-copy' },
                h('p', null, text('connect.scan')),
                h('button', { type: 'button', className: 'dps-button dps-button-primary', onClick: copyLink, disabled: copyState === 'copying' },
                  text(copyState === 'copying' ? 'connect.copying' : 'connect.copy')),
                h('div', { className: 'dps-feedback', role: 'status', 'aria-live': 'polite' }, feedbackKey ? text(feedbackKey) : ''),
                copyState === 'manual' ? h('label', { className: 'dps-manual' }, text('connect.manualLabel'),
                  h('textarea', { ref: manualRef, readOnly: true, rows: 4, spellCheck: false, autoComplete: 'off', value: launchUrl,
                    onFocus: event => event.currentTarget.select() })) : null)),
            h('p', { className: 'dps-warning dps-owner-warning' }, text('connect.ownerWarning'))) : null,
          h('div', { className: 'dps-section' },
            h('h3', null, text('ca.title')),
            h('div', { className: 'dps-ca-actions' },
              h('button', { type: 'button', className: 'dps-button', disabled: !snapshot || !snapshot.caAvailable || downloadState === 'downloading', onClick: downloadCa },
                text(downloadState === 'downloading' ? 'ca.downloading' : 'ca.download')),
              h('a', { ref: downloadAnchorRef, download: 'phone-root-ca.cer', hidden: true, 'aria-hidden': true, tabIndex: -1 })),
            h('div', { className: `dps-feedback${downloadState === 'failed' ? ' dps-error' : ''}`, role: 'status', 'aria-live': 'polite' },
              downloadState === 'downloaded' ? text('ca.downloaded') : downloadState === 'failed' ? text('ca.downloadFailed') :
                snapshot && !snapshot.caAvailable ? text('ca.unavailable') : ''),
            snapshot && snapshot.caFingerprint ? h('p', { className: 'dps-muted' }, text('ca.fingerprint'),
              h('code', { className: 'dps-fingerprint' }, snapshot.caFingerprint)) : null,
            snapshot && snapshot.caNotAfter ? h('p', { className: 'dps-muted' }, text('fact.caExpires'), ': ',
              h('time', { dateTime: snapshot.caNotAfter }, dateLabel(snapshot.caNotAfter))) : null,
            h('ol', null, ['ca.stepDownload', 'ca.stepAndroid', 'ca.stepKind'].map(key => h('li', { key }, text(key)))),
            h('p', { className: 'dps-warning' }, text('ca.trustWarning'))),
          h('div', { className: 'dps-section' },
            h('h3', null, text('help.title')),
            h('ul', null, ['connect.sameLan', 'connect.fallback', 'connect.cookie', 'help.network', 'help.silent', 'help.tls'].map(key => h('li', { key }, text(key)))),
            h('p', { className: 'dps-muted' }, text('help.plugins'))));
      }
      function PhoneIcon({ size }) {
        return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6,
          strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
          h('rect', { x: 6.5, y: 2.5, width: 11, height: 19, rx: 2.5 }),
          h('path', { d: 'M10 5h4M11 18.5h2' }));
      }
      // The shell resolves this label thunk on locale revision; no polling or label re-registration is needed.
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: SECTION_ID, order: 25, label: () => translate('title'), locale: NS,
      }, PhoneAccessSettings));
      ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
        name: 'settings.section.icon', id: SECTION_ID,
      }, PhoneIcon));
    }

    return {
      inject: ['slots', 'locale'], apply,
      // Pure helpers are exported for tests; none captures a live connection, URL or QR.
      normalizeSnapshot, createSnapshotReader, fetchCertificate, statusDetailKey, requestErrorKey, isQrRevealed, nextQrKeyActivation,
      normalizeNetworks, networkAdapterLabel, networkChoices, canApplyNetwork, networkErrorKey, networkSelectionFeedback, networkFeedbackKeys,
      fetchNetworks, applyNetworkSelection, createNetworkSettings,
      localeDictionaries: Object.freeze({ en, ru }),
    };
  },
});
