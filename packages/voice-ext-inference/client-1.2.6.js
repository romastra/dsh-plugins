window.__ModuleLoader__.load({
  id: 'voice-ext-inference',
  factory(require) {
    const React = require('react');
    const ReactDOM = require('react-dom');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState, useSyncExternalStore } = React;

    const NS = 'local-parakeet';
    const ROUTE = '/local-parakeet';
    // A hesitation is not an utterance boundary. Keep several seconds of
    // thinking time in the same recognition window instead of freezing a fragment.
    const STREAM_PAUSE_MS = 5000;
    const SPEECH_RMS = 0.008;

    const DICTS = {
      en: {
        'mic.start': 'Dictate a prompt',
        'mic.stop': 'Stop recording',
        'mic.processing': 'Transcribing…',
        'mic.pending': 'Insert or dismiss the transcript first',
        'status.recording': 'Recording… {seconds}s · click the microphone to stop',
        'status.processing': 'Transcribing with NVIDIA PARAKEET…',
        'status.done': 'Added: {text}',
        'status.pending': 'Transcript ready: {text}',
        'status.insert': 'Insert',
        'status.dismiss': 'Dismiss',
        'error.tooShort': 'The recording is too short. Try again.',
        'error.empty': 'NVIDIA PARAKEET did not recognize any speech. Try speaking more clearly.',
        'error.insert': 'The transcript could not be inserted into the composer. The draft changed while recording; try again.',
        'error.micDenied': 'Allow microphone access in your browser settings.',
        'error.micMissing': 'No microphone was found.',
        'error.micUnsupported': 'This browser does not expose a microphone to the page. Use the Web GUI over localhost or HTTPS.',
        'error.notPrepared': 'The existing Windows Parakeet installation is not ready.',
        'error.preparing': 'The existing Windows installation is being validated. Wait for it to finish.',
        'error.worker': 'The local recognizer could not start.',
        'error.network': 'Could not reach the local voice service. Check the DSH Web connection.',
        'error.generic': 'Voice input failed.',
        'error.submitUnsupported': 'Voice input cannot safely stop on Send in this DSH version. Reload the page or update the plugin.',
        'status.notSent': 'Message not sent: the final transcript could not be committed. Check the voice status and insert the text before sending again.',
        'prepare.title': 'Local NVIDIA PARAKEET (multilingual)',
        'prepare.description': 'The multilingual NVIDIA PARAKEET model uses the existing shared Windows worker on the DSH host (CPU, 6 threads). Phone audio goes only to that computer, without cloud recognition.',
        'prepare.model': 'Model: {model}',
        'prepare.size': 'Installed model size: ~{size} MB',
        'prepare.sizeUnknown': 'Installed model size: reported by Windows runtime',
        'prepare.hint': 'Validate the existing Windows installation; nothing is downloaded or installed here. The shared worker loads the model lazily on the first transcription.',
        'prepare.start': 'Validate installation',
        'prepare.retry': 'Retry',
        'prepare.readyAction': 'Start recording',
        'prepare.preparing': 'Validating…',
        'prepare.ready': 'Installation validated; the model loads on first transcription.',
        'prepare.error': 'Could not validate the existing Windows installation.',
        'prepare.close': 'Close',
        'prepare.phase.checking': 'Checking the existing Windows runtime…',
        'prepare.phase.installing': 'Validating the installed Windows runtime…',
        'prepare.phase.downloading': 'Validating installed model {model}…',
        'prepare.phase.ready': 'Installation validated; the model loads on first transcription.',
        'prepare.phase.error': 'Installation validation failed.',
      },
      ru: {
        'mic.start': 'Надиктовать промпт',
        'mic.stop': 'Остановить запись',
        'mic.processing': 'Распознаю…',
        'mic.pending': 'Сначала вставьте или скройте распознанный текст',
        'status.recording': 'Запись… {seconds} с · нажмите микрофон, чтобы остановить',
        'status.processing': 'Распознаю через NVIDIA PARAKEET…',
        'status.done': 'Добавлено: {text}',
        'status.pending': 'Текст готов: {text}',
        'status.insert': 'Вставить',
        'status.dismiss': 'Скрыть',
        'error.tooShort': 'Запись слишком короткая. Попробуйте ещё раз.',
        'error.empty': 'NVIDIA PARAKEET не распознал речь. Попробуйте сказать чётче.',
        'error.insert': 'Не удалось вставить текст в поле ввода: черновик изменился во время записи. Попробуйте ещё раз.',
        'error.micDenied': 'Разрешите доступ к микрофону в настройках браузера.',
        'error.micMissing': 'Микрофон не найден.',
        'error.micUnsupported': 'Браузер не даёт странице доступ к микрофону. Откройте Web GUI через localhost или HTTPS.',
        'error.notPrepared': 'Установленная Windows-модель Parakeet пока не готова.',
        'error.preparing': 'Проверяется существующая Windows-установка. Дождитесь окончания проверки.',
        'error.worker': 'Локальный распознаватель не запустился.',
        'error.network': 'Не удалось связаться с локальным сервисом распознавания. Проверьте DSH Web.',
        'error.generic': 'Не удалось выполнить голосовой ввод.',
        'error.submitUnsupported': 'В этой версии DSH не удалось подключить безопасную остановку записи при отправке. Обновите страницу или плагин.',
        'status.notSent': 'Сообщение не отправлено: не удалось вставить итоговую расшифровку. Проверьте статус записи и текст перед повторной отправкой.',
        'prepare.title': 'Локальный NVIDIA PARAKEET · многоязычный',
        'prepare.description': 'Многоязычная модель NVIDIA PARAKEET использует уже установленный общий Windows-воркер на компьютере с DSH (CPU, 6 потоков). Аудио с телефона передаётся только ему, без облачного распознавания.',
        'prepare.model': 'Модель: {model}',
        'prepare.size': 'Размер установленной модели: ~{size} МБ',
        'prepare.sizeUnknown': 'Размер установленной модели: указан в Windows-среде',
        'prepare.hint': 'Проверяется уже установленная Windows-модель: здесь ничего не скачивается и не устанавливается. Общий воркер загружает модель только при первом запросе распознавания.',
        'prepare.start': 'Проверить установку',
        'prepare.retry': 'Повторить',
        'prepare.readyAction': 'Начать запись',
        'prepare.preparing': 'Проверка…',
        'prepare.ready': 'Установка проверена; модель загрузится при первом распознавании.',
        'prepare.error': 'Не удалось проверить существующую Windows-установку.',
        'prepare.close': 'Закрыть',
        'prepare.phase.checking': 'Проверяю существующую Windows-среду…',
        'prepare.phase.installing': 'Проверяю установленную Windows-среду…',
        'prepare.phase.downloading': 'Проверяю установленную модель {model}…',
        'prepare.phase.ready': 'Установка проверена; модель загрузится при первом распознавании.',
        'prepare.phase.error': 'Не удалось проверить установку.',
      },
      zh: {
        'mic.start': '语音听写',
        'mic.stop': '停止录音',
        'mic.processing': '正在识别…',
        'mic.pending': '请先插入或关闭识别结果',
        'status.recording': '录音中… {seconds} 秒 · 点击麦克风停止',
        'status.processing': '正在使用 NVIDIA PARAKEET 识别…',
        'status.done': '已添加：{text}',
        'status.pending': '识别结果：{text}',
        'status.insert': '插入',
        'status.dismiss': '关闭',
        'error.tooShort': '录音太短，请重试。',
        'error.empty': 'NVIDIA PARAKEET 未识别到语音，请说得更清楚一些。',
        'error.insert': '无法将识别结果插入输入框：录音期间草稿已更改，请重试。',
        'error.micDenied': '请在浏览器设置中允许使用麦克风。',
        'error.micMissing': '未找到麦克风。',
        'error.micUnsupported': '当前浏览器不允许页面使用麦克风。请通过 localhost 或 HTTPS 打开 Web GUI。',
        'error.notPrepared': '现有 Windows Parakeet 安装尚未就绪。',
        'error.preparing': '正在验证现有 Windows 安装，请等待完成。',
        'error.worker': '本地识别器未能启动。',
        'error.network': '无法连接本地语音服务，请检查 DSH Web。',
        'error.generic': '语音输入失败。',
        'error.submitUnsupported': '此 DSH 版本无法在发送前安全地停止录音。请刷新页面或更新插件。',
        'status.notSent': '消息未发送：无法插入最终识别文本。请检查录音状态和文本后再发送。',
        'prepare.title': '本地 NVIDIA PARAKEET（多语言）',
        'prepare.description': '多语言 NVIDIA PARAKEET 模型使用 DSH 主机上已安装的共享 Windows 工作进程（CPU，6 线程）。手机音频仅发送至该计算机，不使用云端识别。',
        'prepare.model': '模型：{model}',
        'prepare.size': '已安装模型大小：约 {size} MB',
        'prepare.sizeUnknown': '已安装模型大小：由 Windows 环境报告',
        'prepare.hint': '仅验证现有 Windows 安装；此处不会下载或安装任何内容。共享工作进程仅在首次识别请求时延迟加载模型。',
        'prepare.start': '验证安装',
        'prepare.retry': '重试',
        'prepare.readyAction': '开始录音',
        'prepare.preparing': '验证中…',
        'prepare.ready': '安装已验证；模型将在首次识别时加载。',
        'prepare.error': '无法验证现有 Windows 安装。',
        'prepare.close': '关闭',
        'prepare.phase.checking': '正在检查现有 Windows 环境…',
        'prepare.phase.installing': '正在验证已安装的 Windows 环境…',
        'prepare.phase.downloading': '正在验证已安装的模型 {model}…',
        'prepare.phase.ready': '安装已验证；模型将在首次识别时加载。',
        'prepare.phase.error': '安装验证失败。',
      },
    };

    Object.assign(DICTS.en, {
      'status.autoSend': 'Sending in {seconds}s · focus the text field to review',
      'status.cancelAutoSend': 'Cancel auto-send',
      'status.limitProcessing': 'Recording limit reached ({time}). Finishing transcription…',
      'status.limitDone': 'Recording stopped at {time}. The transcript is in your draft.',
      'status.limitPending': 'Recording stopped at {time}. Ready to insert: {text}',
      'status.limitFailed': 'Recording stopped at {time}. {error}',
      'status.retryFinal': 'Retry transcription',
      'status.discardTake': 'Discard recording',
      'status.finalUncertain': 'No text was recognized in some audio segments. Review the transcript before sending.',
      'error.rigFinal': 'Polaris could not finish transcribing. Your recording is kept for retry.',
      'error.rigBusyFinal': 'Polaris is temporarily busy. Your recording is kept for retry.',
      'hold.unavailable': 'Voice input is unavailable while this field is busy. Finish the current recording/submission or answer the pending question.',
    });
    Object.assign(DICTS.ru, {
      'status.autoSend': 'Отправка через {seconds} с · фокус в поле отменит её',
      'status.cancelAutoSend': 'Не отправлять',
      'status.limitProcessing': 'Достигнут лимит {time}. Завершаю распознавание…',
      'status.limitDone': 'Запись остановлена на {time}. Текст в черновике.',
      'status.limitPending': 'Запись остановлена на {time}. Готово к вставке: {text}',
      'status.limitFailed': 'Запись остановлена на {time}. {error}',
      'status.retryFinal': 'Повторить распознавание',
      'status.discardTake': 'Удалить запись',
      'status.finalUncertain': 'В некоторых фрагментах речь не распознана. Проверьте текст перед отправкой.',
      'error.rigFinal': 'Polaris не смог завершить распознавание. Запись сохранена для повтора.',
      'error.rigBusyFinal': 'Polaris временно занят. Запись сохранена для повтора.',
      'hold.unavailable': 'Поле ввода сейчас занято. Завершите текущую запись/отправку или ответьте на ожидающий вопрос, затем повторите удержание.',
    });
    Object.assign(DICTS.zh, {
      'status.autoSend': '{seconds} 秒后发送 · 点击文本框可取消',
      'status.cancelAutoSend': '取消自动发送',
      'status.limitProcessing': '已达录音上限（{time}），正在完成识别…',
      'status.limitDone': '录音在 {time} 停止，识别文本已放入草稿。',
      'status.limitPending': '录音在 {time} 停止，可插入识别结果：{text}',
      'status.limitFailed': '录音在 {time} 停止。{error}',
      'status.retryFinal': '重试识别',
      'status.discardTake': '丢弃录音',
      'status.finalUncertain': '部分录音未识别出文字，请在发送前检查识别结果。',
      'error.rigFinal': 'Polaris 未能完成识别。录音已保留，可重试。',
      'error.rigBusyFinal': 'Polaris 暂时繁忙。录音已保留，可重试。',
      'hold.unavailable': '输入框当前正忙。请先结束录音或发送，或回答待处理的问题，然后重试。',
    });

    applyRigCopy(DICTS);
    applyMicrophoneCopy(DICTS);

    const STYLE = `
      /* Browser pan/zoom ownership is decided before PointerDown. Limit this
         to the native primary action in a composer that provides hold-to-talk. */
      [data-composer-card]:has([data-dsh-lp-hold]) button[aria-busy][aria-label]:not(.dsh-lp-mic) {
        touch-action: none;
        -webkit-touch-callout: none;
      }
      .dsh-lp-limit-flash {
        position: fixed; inset: 0; z-index: 10000; pointer-events: none;
        background: color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent);
        box-shadow: inset 0 0 0 4px var(--dsw-alias-brand-primary);
        animation: dsh-lp-limit-flash 640ms ease-out both;
      }
      @keyframes dsh-lp-limit-flash { 0% { opacity: 0; } 20% { opacity: .82; } 100% { opacity: 0; } }
      @media (prefers-reduced-motion: reduce) { .dsh-lp-limit-flash { display: none; } }
      .dsh-lp-mic.dsh-lp-device-trigger { width: 24px; margin-left: 1px; }
      .dsh-lp-device-trigger[aria-expanded="true"] {
        background: var(--dsw-alias-bg-layer-2);
        color: var(--dsw-alias-label-primary);
      }
      .dsh-lp-device-menu {
        /* Match UI Zoom's viewport coordinate layer, not the scaled document. */
        zoom: var(--dsh-ui-zoom-inverse, 1);
        position: fixed; z-index: 10000; box-sizing: border-box; margin: 0;
        overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain;
        padding: calc(6px * var(--dsh-ui-zoom-factor, 1));
        border-radius: calc(12px * var(--dsh-ui-zoom-factor, 1));
        border: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary);
        box-shadow: 0 8px 24px color-mix(in srgb, var(--dsw-alias-label-primary) 16%, transparent);
        font-size: 13px; line-height: 18px; overflow-wrap: anywhere;
      }
      .dsh-lp-device-content { zoom: var(--dsh-ui-zoom-factor, 1); }
      .dsh-lp-device-menu:focus { outline: none; }
      .dsh-lp-device-title { margin: 5px 8px 4px; font-weight: 600; }
      .dsh-lp-device-options { display: grid; grid-template-columns: minmax(0, 1fr); gap: 2px; }
      .dsh-lp-device-option {
        appearance: none; display: flex; align-items: center; gap: 8px; box-sizing: border-box;
        width: 100%; min-width: 0; min-height: 32px; padding: 5px 8px; border: 0; border-radius: 6px;
        background: transparent; color: inherit; font: inherit; text-align: left;
        overflow-wrap: anywhere; cursor: pointer;
      }
      .dsh-lp-device-option[aria-pressed="true"], .dsh-lp-device-option:hover:not(:disabled) {
        background: var(--dsw-alias-bg-layer-2);
      }
      .dsh-lp-device-menu button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
      .dsh-lp-device-option:disabled, .dsh-lp-device-action[aria-disabled="true"] { opacity: .65; cursor: wait; }
      .dsh-lp-device-check { width: 1em; flex: 0 0 auto; color: var(--dsw-alias-brand-primary); }
      .dsh-lp-device-info { margin: 6px 8px; overflow-wrap: anywhere; color: var(--dsw-alias-label-secondary); }
      .dsh-lp-device-info[role="alert"] { color: var(--dsw-alias-state-error-primary); }
      .dsh-lp-device-action { margin: 4px 8px; max-width: calc(100% - 16px); white-space: normal; overflow-wrap: anywhere; }
      @media (pointer: coarse) {
        .dsh-lp-mic.dsh-lp-device-trigger { width: 36px; min-height: 32px; }
        .dsh-lp-device-option { min-height: 40px; }
      }
      .dsh-lp-mic {
        appearance: none;
        border: 1px solid transparent;
        background: transparent;
        color: var(--dsw-alias-label-secondary);
        width: 28px;
        height: 28px;
        padding: 0;
        border-radius: 8px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: background .15s ease, color .15s ease, border-color .15s ease;
      }
      .dsh-lp-mic:hover:not(:disabled) {
        background: var(--dsw-alias-bg-layer-2);
        color: var(--dsw-alias-label-primary);
      }
      .dsh-lp-mic:focus-visible {
        outline: 2px solid var(--dsw-alias-brand-primary);
        outline-offset: 1px;
      }
      .dsh-lp-mic:disabled { cursor: progress; opacity: .65; }
      .dsh-lp-mic-rec {
        color: var(--dsw-alias-state-error-primary);
        background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 13%, transparent);
        border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 35%, transparent);
      }
      .dsh-lp-spin { animation: dsh-lp-spin 1s linear infinite; }
      @keyframes dsh-lp-spin { to { transform: rotate(360deg); } }
      .dsh-lp-status {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        max-width: 100%;
        min-height: 26px;
        padding: 3px 10px;
        border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 999px;
        background: var(--dsw-alias-bg-layer-1);
        color: var(--dsw-alias-label-secondary);
        font-size: 12px;
        line-height: 18px;
      }
      .dsh-lp-status-rec { color: var(--dsw-alias-state-error-primary); }
      .dsh-lp-status-err { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 35%, transparent); }
      .dsh-lp-status-ok { color: var(--dsw-alias-state-success-primary); }
      .dsh-lp-status-pending { color: var(--dsw-alias-state-warn-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 35%, transparent); }
      .dsh-lp-status { box-sizing: border-box; align-self: flex-start; }
      .dsh-lp-status-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
      .dsh-lp-status-err .dsh-lp-status-text,
      .dsh-lp-status-pending .dsh-lp-status-text,
      .dsh-lp-status-limit .dsh-lp-status-text,
      .dsh-lp-status-uncertain .dsh-lp-status-text { white-space: normal; overflow-wrap: anywhere; }
      .dsh-lp-dot {
        width: 7px; height: 7px; border-radius: 999px;
        background: currentColor; flex: 0 0 auto;
      }
      .dsh-lp-dot-rec { animation: dsh-lp-pulse 1.15s ease-in-out infinite; }
      @keyframes dsh-lp-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
      .dsh-lp-dismiss {
        appearance: none; border: 0; background: transparent; color: inherit;
        width: 18px; height: 18px; padding: 0; border-radius: 999px;
        font-size: 14px; line-height: 1; cursor: pointer; opacity: .7;
      }
      .dsh-lp-dismiss:hover { opacity: 1; background: var(--dsw-alias-bg-layer-2); }
      .dsh-lp-insert {
        appearance: none;
        border: 1px solid currentColor;
        background: transparent;
        color: inherit;
        height: 20px;
        padding: 0 7px;
        border-radius: 999px;
        font: inherit;
        font-size: 11px;
        line-height: 18px;
        cursor: pointer;
        flex: 0 0 auto;
      }
      .dsh-lp-insert:hover { background: var(--dsw-alias-bg-layer-2); }
      .dsh-lp-backdrop {
        position: fixed;
        inset: 0;
        z-index: 10000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: var(--dsw-alias-bg-overlay);
        background: color-mix(in srgb, var(--dsw-alias-state-idle-primary) 35%, transparent);
        backdrop-filter: blur(2px);
      }
      .dsh-lp-dialog {
        width: min(480px, 100%);
        max-height: min(640px, 90vh);
        overflow: auto;
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 20px;
        border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 14px;
        background: var(--dsw-alias-bg-overlay);
        color: var(--dsw-alias-label-primary);
        box-shadow: 0 18px 60px color-mix(in srgb, var(--dsw-alias-label-primary) 22%, transparent);
        font-size: 14px;
        line-height: 20px;
      }
      .dsh-lp-dialog h2 { margin: 0; font-size: 17px; line-height: 24px; font-weight: 600; }
      .dsh-lp-dialog p { margin: 0; color: var(--dsw-alias-label-secondary); }
      .dsh-lp-field { display: flex; flex-direction: column; gap: 6px; margin-top: 2px; }
      .dsh-lp-field label { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
      .dsh-lp-input {
        width: 100%;
        box-sizing: border-box;
        padding: 8px 10px;
        border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 8px;
        background: var(--dsw-alias-bg-layer-1);
        color: var(--dsw-alias-label-primary);
        font: inherit;
        font-size: 13px;
      }
      .dsh-lp-input:focus { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 0; border-color: transparent; }
      .dsh-lp-hint { font-size: 12px; line-height: 17px; color: var(--dsw-alias-label-secondary); }
      .dsh-lp-model {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 8px 10px;
        border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 8px;
        background: var(--dsw-alias-bg-layer-1);
        font-size: 13px;
      }
      .dsh-lp-prepare-status {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 10px;
        border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 8px;
        background: var(--dsw-alias-bg-layer-1);
        color: var(--dsw-alias-label-secondary);
        font-size: 13px;
        line-height: 18px;
        word-break: break-word;
      }
      .dsh-lp-prepare-status .dsh-lp-dot { background: currentColor; }
      .dsh-lp-error { font-size: 12px; line-height: 17px; color: var(--dsw-alias-state-error-primary); }
      .dsh-lp-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
      .dsh-lp-button {
        appearance: none;
        border: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-layer-1);
        color: var(--dsw-alias-label-primary);
        border-radius: 8px;
        padding: 6px 12px;
        font: inherit;
        font-size: 13px;
        cursor: pointer;
      }
      .dsh-lp-button:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
      .dsh-lp-button:disabled { cursor: progress; opacity: .65; }
      .dsh-lp-button-primary {
        border-color: var(--dsw-alias-brand-primary);
        background: var(--dsw-alias-brand-primary);
        color: var(--dsw-alias-bg-base);
      }
      .dsh-lp-button-primary:hover:not(:disabled) {
        background: var(--dsw-alias-brand-primary);
        opacity: .9;
      }
      .dsh-lp-mic { flex: 0 0 auto; order: 1; }
      .dsh-lp-activity {
        position: relative;
        display: flex;
        align-items: center;
        flex: 1 1 auto;
        min-width: 0;
      }
      .dsh-lp-activity-rec .dsh-lp-wave { padding-right: 40px; }
      .dsh-lp-activity-rec .dsh-lp-mic {
        position: absolute;
        right: 0;
        top: 50%;
        transform: translateY(-50%);
      }
      .dsh-lp-wave {
        order: 0;
        display: flex;
        align-items: center;
        gap: 2px;
        flex: 1 1 0;
        min-width: 0;
        height: 24px;
        padding: 0 4px;
        overflow: hidden;
        pointer-events: none;
      }
      .dsh-lp-wave-bar {
        flex: 1 1 0;
        min-width: 0;
        border-radius: 999px;
        background: var(--dsw-alias-brand-primary);
        opacity: .78;
        transition: height 80ms linear;
      }
      .dsh-lp-wave-bar-clip {
        background: var(--dsw-alias-state-error-primary);
        opacity: 1;
      }
    `;

    const store = {
      state: { phase: 'idle', message: '', elapsed: 0, sessionId: null },
      listeners: new Set(),
    };

    const EMPTY_LEVELS = [];
    const EMPTY_CLIPS = [];
    const EMPTY_AUDIO = { levels: EMPTY_LEVELS, clips: EMPTY_CLIPS };
    const levelStore = {
      state: { sessionId: null, levels: EMPTY_LEVELS, clips: EMPTY_CLIPS },
      listeners: new Set(),
    };

    function publishLevels(sessionId, levels, clips) {
      levelStore.state = { sessionId, levels, clips };
      for (const listener of levelStore.listeners) {
        try {
          listener();
        } catch {
          // A broken listener must not stop the others.
        }
      }
    }

    function useLevels(sessionId) {
      const [snapshot, setSnapshot] = useState(levelStore.state);
      useEffect(() => {
        const off = subscribeLevels(() => setSnapshot(levelStore.state));
        setSnapshot(levelStore.state);
        return off;
      }, []);
      return snapshot.sessionId === sessionId
        ? { levels: snapshot.levels, clips: snapshot.clips }
        : EMPTY_AUDIO;
    }

    function subscribeLevels(listener) {
      levelStore.listeners.add(listener);
      return () => levelStore.listeners.delete(listener);
    }

    function publish(patch) {
      store.state = { ...store.state, limitSeconds: null, canRetryFinal: false, uncertainFinal: false, ...patch };
      for (const listener of store.listeners) {
        try {
          listener();
        } catch {
          // A broken listener must not stop the others.
        }
      }
    }

    function subscribe(listener) {
      store.listeners.add(listener);
      return () => store.listeners.delete(listener);
    }

    function useStore() {
      const [snapshot, setSnapshot] = useState(store.state);
      useEffect(() => {
        const off = subscribe(() => setSnapshot(store.state));
        setSnapshot(store.state);
        return off;
      }, []);
      return snapshot;
    }

    function useT(locale) {
      return useCallback(
        (key, vars) => {
          let template;
          try {
            template = locale?.bind?.(NS)?.(key);
          } catch {
            template = undefined;
          }
          if (typeof template !== 'string' || template.length === 0 || template === key) {
            let localeId = 'ru';
            try {
              const snapshot = locale?.getLocale?.();
              localeId = snapshot?.active ?? snapshot?.id ?? 'ru';
            } catch {
              localeId = 'ru';
            }
            const table = localeId.startsWith('ru') ? DICTS.ru : localeId.startsWith('zh') ? DICTS.zh : DICTS.en;
            template = table[key] ?? DICTS.en[key] ?? key;
          }
          if (vars && typeof template === 'string') {
            for (const [name, value] of Object.entries(vars)) {
              template = template.replaceAll(`{${name}}`, () => String(value));
            }
          }
          return template;
        },
        [locale],
      );
    }

    async function api(path, options = {}) {
      let response;
      try {
        response = await fetch(`${ROUTE}${path}`, {
          method: options.method ?? 'GET',
          headers: options.headers,
          body: options.body,
          signal: options.signal,
          credentials: 'same-origin',
          cache: 'no-store',
          keepalive: options.keepalive === true,
          redirect: 'error',
        });
      } catch {
        const error = new Error('network');
        error.status = 0;
        throw error;
      }

      const text = await response.text();
      let payload = null;
      try {
        payload = text.length > 0 ? JSON.parse(text) : null;
      } catch {
        payload = null;
      }

      if (!response.ok) {
        const error = new Error(payload?.error || text || `HTTP ${response.status}`);
        error.status = response.status;
        error.detail = payload?.detail;
        error.code = payload?.code;
        throw error;
      }
      if (path === '/transcribe' && typeof payload?.text === 'string' && (payload.text.trim() || payload.noSpeech === true) && typeof payload.id === 'string' && /^[-A-Za-z0-9_]{1,80}$/.test(payload.id)) {
        // Delivery ownership belongs to this browser, not to Host response.write/end.
        void api('/ack', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: payload.id }), keepalive: true }).catch(() => {});
      }
      return payload;
    }

    function mergeChunks(chunks) {
      let total = 0;
      for (const chunk of chunks) total += chunk.length;
      const merged = new Float32Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      return merged;
    }

    function downsample(samples, inputRate, outputRate) {
      if (!Number.isFinite(inputRate) || inputRate <= outputRate) return samples;
      const ratio = inputRate / outputRate;
      const length = Math.max(0, Math.floor(samples.length / ratio));
      const result = new Float32Array(length);
      for (let index = 0; index < length; index += 1) {
        const start = Math.floor(index * ratio);
        const end = Math.min(Math.floor((index + 1) * ratio), samples.length);
        let sum = 0;
        for (let cursor = start; cursor < end; cursor += 1) sum += samples[cursor];
        result[index] = sum / Math.max(1, end - start);
      }
      return result;
    }

    function encodeWav(samples, inputRate) {
      if (!Number.isFinite(inputRate) || inputRate < 1) throw new Error('Invalid audio sample rate');
      const rate = Math.min(16000, Math.round(inputRate));
      const data = downsample(samples, inputRate, rate);
      const buffer = new ArrayBuffer(44 + data.length * 2);
      const view = new DataView(buffer);
      writeAscii(view, 0, 'RIFF');
      view.setUint32(4, 36 + data.length * 2, true);
      writeAscii(view, 8, 'WAVE');
      writeAscii(view, 12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, rate, true);
      view.setUint32(28, rate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      writeAscii(view, 36, 'data');
      view.setUint32(40, data.length * 2, true);
      let offset = 44;
      for (let index = 0; index < data.length; index += 1) {
        const sample = Math.max(-1, Math.min(1, data[index]));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        offset += 2;
      }
      return new Blob([buffer], { type: 'audio/wav' });
    }

    function writeAscii(view, offset, value) {
      for (let index = 0; index < value.length; index += 1) {
        view.setUint8(offset + index, value.charCodeAt(index));
      }
    }

    function captureInsertion(inputActions) {
      try {
        return inputActions?.captureInsertion?.();
      } catch {
        return undefined;
      }
    }

    const NO_SPACE_BEFORE = /^[.,!?;:…)\]}»”’]/u;
    const NO_SPACE_AFTER = /^[.,!?;:…)\]}»”’]/u;
    const OPEN_END = /[\s([{«„“‘]$/u;
    const OPEN_BEFORE = /[([{«„“‘]$/u;

    /**
     * Put the transcript between existing words without gluing it to them.
     * The span is in the same detect coordinates captureInsertion returned, so
     * the characters immediately outside a collapsed caret (or a selection)
     * decide whether a separating space is needed.
     */
    function withSpacing(text, draft, span) {
      const clean = String(text).trim();
      if (clean.length === 0) return clean;
      const source = typeof draft === 'string' ? draft : '';
      const start = span && Number.isFinite(span.start) ? span.start : null;
      const end = span && Number.isFinite(span.end) ? span.end : null;
      const before = start === null ? '' : source.slice(0, start);
      const after = end === null ? '' : source.slice(end);
      let result = clean;

      if (before.length > 0 && !/\s$/u.test(before) && !OPEN_BEFORE.test(before) && !NO_SPACE_BEFORE.test(result)) {
        result = ` ${result}`;
      }
      if (
        after.length > 0 &&
        !/^\s/u.test(after) &&
        !NO_SPACE_AFTER.test(after) &&
        !/\s$/u.test(result) &&
        !OPEN_END.test(result)
      ) {
        result = `${result} `;
      }
      return result;
    }

    function joinText(left, right) {
      const a = String(left ?? '').trim();
      const b = String(right ?? '').trim();
      if (a.length === 0) return b;
      if (b.length === 0) return a;
      return `${a} ${b}`;
    }

    function composeStreamDraft(base, finalized, partial) {
      const tail = joinText(finalized, partial);
      if (tail.length === 0) return base;
      const needsSpace =
        base.length > 0 &&
        !/\s$/u.test(base) &&
        !OPEN_BEFORE.test(base) &&
        !NO_SPACE_BEFORE.test(tail);
      return `${base}${needsSpace ? ' ' : ''}${tail}`;
    }

    function insertTranscript(text, insertion, inputActions, draft) {
      if (!inputActions || typeof inputActions.insertText !== 'function') return false;
      const clean = String(text).trim();
      if (clean.length === 0) return false;
      if (insertion !== undefined) {
        try {
          if (inputActions.insertText(withSpacing(clean, draft, insertion), insertion) !== false) return true;
        } catch {
          // The revision moved; fall through to a fresh insertion point.
        }
      }
      try {
        const fresh = captureInsertion(inputActions);
        return inputActions.insertText(withSpacing(clean, draft, fresh), fresh) !== false;
      } catch {
        return false;
      }
    }

    function friendlyError(error) {
      if (!error) return 'error.generic';
      if (error.name === 'NotAllowedError' || error.name === 'SecurityError') return 'error.micDenied';
      if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') return 'error.micMissing';
      if (error.status === 409) return error.code === 'preparing' ? 'error.preparing' : 'error.notPrepared';
      if (error.status === 503) return error.message || 'error.worker';
      if (error.status === 0 || error instanceof TypeError) return 'error.network';
      return error.message || 'error.generic';
    }

    function preview(text) {
      const oneLine = String(text).replace(/\s+/g, ' ').trim();
      return oneLine.length > 72 ? `${oneLine.slice(0, 72)}…` : oneLine;
    }

    function MicIcon() {
      return h(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('rect', { x: 9, y: 2, width: 6, height: 12, rx: 3 }),
        h('path', { d: 'M5 10v1a7 7 0 0 0 14 0v-1' }),
        h('line', { x1: 12, y1: 19, x2: 12, y2: 22 }),
      );
    }

    function StopIcon() {
      return h(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 24 24',
          fill: 'currentColor',
          'aria-hidden': true,
        },
        h('rect', { x: 6, y: 6, width: 12, height: 12, rx: 2 }),
      );
    }

    function Spinner() {
      return h(
        'svg',
        {
          className: 'dsh-lp-spin',
          width: 16,
          height: 16,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': true,
        },
        h('circle', { cx: 12, cy: 12, r: 8, stroke: 'currentColor', strokeWidth: 3, opacity: 0.25 }),
        h('path', { d: 'M20 12a8 8 0 0 0-8-8', stroke: 'currentColor', strokeWidth: 3, strokeLinecap: 'round' }),
      );
    }

    function Waveform(props) {
      const { levels, clips } = props;
      const bars = Array.from({ length: 96 }, () => ({ level: 0, clip: false }));
      const offset = Math.max(0, bars.length - levels.length);
      for (let index = 0; index < levels.length && offset + index < bars.length; index += 1) {
        bars[offset + index] = {
          level: levels[index],
          clip: Boolean(clips?.[index]),
        };
      }
      return h(
        'div',
        { className: 'dsh-lp-wave', 'aria-hidden': true },
        bars.map((bar, index) =>
          h('span', {
            key: index,
            className: `dsh-lp-wave-bar${bar.clip ? ' dsh-lp-wave-bar-clip' : ''}`,
            style: { height: `${Math.max(2, Math.round(bar.level * 22))}px` },
          }),
        ),
      );
    }

    // DSH 0.2.2-rc.3 has no before-submit hook. Its public SessionInput.submit
    // facade is the common dynamic call site for Send, Enter and InputActions.
    // Wrap only this exact mounted Session generation, never host DOM/React internals.
    function interceptSubmit(input, { needsFinish, finish, isCurrent, onError, onBlocked }) {
      const own = Object.getOwnPropertyDescriptor(input, 'submit');
      let descriptor;
      for (let owner = input; owner && !descriptor; owner = Object.getPrototypeOf(owner)) {
        descriptor = Object.getOwnPropertyDescriptor(owner, 'submit');
      }
      const original = descriptor?.value;
      if (typeof original !== 'function') throw new Error('local-parakeet: missing SessionInput.submit');
      let enabled = true;
      let pending = null;
      function submit(...args) {
        if (!enabled) return Reflect.apply(original, this, args);
        if (pending) return;
        if (!needsFinish()) return Reflect.apply(original, this, args);
        const receiver = this;
        const attempt = {};
        pending = attempt; // Close the gate even against synchronous reentrant clicks.
        try {
          // finish() stops the tracks synchronously, before its first await.
          const result = finish();
          void Promise.resolve(result).then((ok) => {
            if (!enabled || !isCurrent()) return;
            if (ok === true) Reflect.apply(original, receiver, args);
            else onBlocked?.();
          }).catch(onError).finally(() => { if (pending === attempt) pending = null; });
        } catch (error) {
          pending = null;
          onError(error);
        }
      }
      Object.defineProperty(input, 'submit', { configurable: true, writable: true, enumerable: descriptor.enumerable, value: submit });
      diagnostics.guards += 1;
      return () => {
        if (!enabled) return;
        enabled = false;
        diagnostics.guards -= 1;
        // Preserve later wrappers. If they retained ours, it becomes a transparent
        // pass-through rather than calling a stale microphone after unload.
        if (Object.getOwnPropertyDescriptor(input, 'submit')?.value !== submit) return;
        if (own) Object.defineProperty(input, 'submit', own);
        else Reflect.deleteProperty(input, 'submit');
      };
    }

    const diagnostics = { guards: 0, microphonePickers: 0, lastTouchHold: null, lastRecordingLimit: null };
    const voiceControls = new Map();

// Pure state machines plus a behavioral-only, rc.3 native-button event adapter.
// No host DOM is changed, no geometry/CSS/React internals are inspected.
function createReviewCountdown({ read, current, submit, publish, now = Date.now, setInterval, clearInterval, seconds = 30 }) {
  let active;
  let timer;
  let disposed = false;
  function cancel(reason = 'cancelled') {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    const previous = active;
    active = undefined;
    if (previous) publish({ active: false, reason });
  }
  function tick() {
    if (!active || disposed) return;
    const snapshot = read();
    const attachments = snapshot.attachmentIds ?? [];
    if (!current() || snapshot.draftRev !== active.revision || snapshot.draft !== active.text || snapshot.phase !== 'plain' ||
        attachments.length !== active.attachments.length || attachments.some((id, index) => id !== active.attachments[index])) {
      cancel('changed');
      return;
    }
    const remaining = Math.max(0, Math.ceil((active.deadline - now()) / 1000));
    if (remaining === 0) {
      const args = active.args;
      cancel('sent'); // Clear ownership before the native send can publish again.
      submit(...args);
    } else publish({ active: true, remaining, deadline: active.deadline });
  }
  return {
    arm(args = ['queue', 'click']) {
      cancel();
      const snapshot = read();
      if (disposed || !current() || snapshot.targetKind === 'question' || snapshot.phase !== 'plain' || !snapshot.draft.trim() || snapshot.draft.trimStart().startsWith('/')) return false;
      active = { text: snapshot.draft, revision: snapshot.draftRev, attachments: [...(snapshot.attachmentIds ?? [])], deadline: now() + seconds * 1000, args };
      timer = setInterval(tick, 250);
      tick();
      return true;
    },
    cancel,
    check: tick,
    active: () => Boolean(active),
    dispose() { disposed = true; cancel('disposed'); },
  };
}

// A deliberate new hold replaces a failed take just like the microphone button.
// Global browser focus belongs to auto-send safety, not to capture eligibility.
function canBeginHold({ current, guardReady, locked = false, recording, starting, finishing, phase }) {
  return Boolean(current && guardReady && !locked && !recording && !starting && !finishing && ['plain', 'claimed'].includes(phase));
}

function createHoldGesture({ start, stop, cancel, hasCapture, reviewed, allowed = () => true, unavailable, captureOwner = () => null, setTimeout, clearTimeout, delay = 300 }) {
  let press;
  let generation = 0;
  let alive = true;
  function abort() {
    generation += 1;
    const previous = press;
    press = undefined;
    if (previous) clearTimeout(previous.timer);
    if (previous?.held && !previous.denied && previous.owner === captureOwner()) void cancel();
  }
  return {
    down(id, args) {
      if (!alive || press) return false;
      const own = { id, args, held: false, generation: ++generation };
      press = own;
      own.timer = setTimeout(() => {
        if (!alive || press !== own) return;
        own.held = true;
        if (!allowed()) { own.denied = true; try { unavailable?.(); } catch {} return; }
        try { void Promise.resolve(start()).catch(() => {}); } catch { /* A failed start cannot authorize a send. */ }
        own.owner = captureOwner();
      }, delay);
      return true;
    },
    up(id, args) {
      const own = press;
      if (!own || own.id !== id) return false;
      press = undefined;
      clearTimeout(own.timer);
      if (!own.held) return false; // Preserve an ordinary native tap.
      if (own.denied) return true; // Explain the refusal without executing native Stop/Continue.
      if (args !== undefined) own.args = args;
      if (own.owner !== captureOwner()) return true; // Never finish a different take.
      const captured = hasCapture();
      let result;
      try { result = stop(); } catch { return true; }
      void Promise.resolve(result).then(ok => {
        if (ok === true && captured && alive && generation === own.generation) reviewed(own.args);
      }).catch(() => {});
      return true;
    },
    held: () => Boolean(press?.held),
    pressed: () => Boolean(press),
    abort,
    dispose() { alive = false; abort(); },
  };
}

const TOUCH_HOLD_SLOP_FRACTION = 0.15;

function touchHoldRadius(view) {
  // Compare client coordinates to the visible CSS viewport, not physical pixels
  // or the zoomed dimensions of the button. Freeze the radius at pointerdown.
  const vv = view.visualViewport;
  const valid = (width, height) => Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
  const size = vv && valid(vv.width, vv.height) ? vv : { width: view.innerWidth, height: view.innerHeight };
  return valid(size.width, size.height) ? Math.min(size.width, size.height) * TOUCH_HOLD_SLOP_FRACTION : 90;
}

function bindNativeHold({ root, input, labels, allowed, start, stop, cancel, hasCapture, captureOwner, reviewed, focus, changed, unavailable, trace = () => {}, document: doc, window: win }) {
  let point;
  let echo;
  const consume = event => { event.preventDefault(); event.stopPropagation(); };
  const rememberRelease = (contact, blockClick) => {
    echo = { button: contact.button, id: contact.id, touch: contact.touch, blockClick, until: Date.now() + 1500 };
  };
  const isEcho = (event, button) => {
    if (!echo || Date.now() > echo.until) { echo = undefined; return false; }
    if (echo.touch && event.pointerType === 'touch' && event.pointerId >= 0) return event.pointerId === echo.id;
    if (event.detail === 0) return false; // Keyboard/programmatic clicks did not come from this press.
    return button === echo.button;
  };
  const gesture = createHoldGesture({ start, stop, cancel, hasCapture, captureOwner, reviewed, allowed, unavailable,
    setTimeout: win.setTimeout.bind(win), clearTimeout: win.clearTimeout.bind(win) });
  const card = () => root()?.closest('[data-composer-card]');
  function buttonIntent(button) {
    const parent = card();
    if (!parent || !button || button.closest('[data-composer-card]') !== parent || button.getAttribute('aria-busy') === 'true' || button.hasAttribute('data-sending')) return;
    const label = button.getAttribute('aria-label');
    const index = labels().indexOf(label);
    if (index < 0) return;
    return { button, args: [index === 2 ? 'steer' : 'queue', 'click'] };
  }
  const nativeButton = event => buttonIntent(event.target?.closest?.('button'));
  const isEditor = target => card()?.contains(target) && target?.matches?.('textarea,input,[contenteditable="true"],[role="textbox"]');
  const onDown = event => {
    if (isEditor(event.target)) focus();
    if (event.button !== 0 || event.isPrimary === false || point || gesture.pressed()) return;
    const native = nativeButton(event);
    if (!native || !gesture.down(event.pointerId, native.args)) return;
    echo = undefined;
    const touch = event.pointerType === 'touch';
    const activeElement = doc.activeElement;
    point = { button: native.button, x: event.clientX, y: event.clientY, id: event.pointerId,
      touch, radius: touch ? touchHoldRadius(win) : null, dragCancelled: false,
      editor: isEditor(activeElement) ? activeElement : null };
    // Prevent focus transfer before it happens. Cancelling PointerDown suppresses
    // compatibility mouse focus, but still allows an ordinary native short click.
    event.preventDefault();
  };
  const beyond = (contact, sample, radius) => Math.hypot(sample.clientX - contact.x, sample.clientY - contact.y) > radius;
  const report = (contact, outcome) => {
    if (!contact.touch) return;
    try { trace({ outcome, editorWasFocused: Boolean(contact.editor), editorFocused: Boolean(isEditor(doc.activeElement)),
      focusPreserved: contact.editor ? doc.activeElement === contact.editor : !isEditor(doc.activeElement) }); } catch { /* Diagnostics are not behavior. */ }
  };
  const cancelTouchDrag = contact => {
    if (!contact.dragCancelled) {
      contact.dragCancelled = true;
      gesture.abort();
      focus(); // Invalidate pending auto-send, without calling any DOM focus API.
    }
  };
  const onUp = event => {
    const contact = point;
    if (!contact || contact.id !== event.pointerId) return;
    const held = gesture.held();
    if (contact.touch && beyond(contact, event, contact.radius)) cancelTouchDrag(contact);
    point = undefined;
    const consumed = contact.dragCancelled || gesture.up(event.pointerId, buttonIntent(contact.button)?.args);
    rememberRelease(contact, consumed);
    if (contact.dragCancelled || held) report(contact, contact.dragCancelled ? 'drag-cancelled' : 'released');
    if (consumed) consume(event);
  };
  const onMove = event => {
    const contact = point;
    if (!contact || contact.id !== event.pointerId) return;
    if (contact.touch) {
      // A canceled drag remains owned until lift, even after a long pause or a
      // return to the button. Neither a late release nor its click can send.
      if (!contact.dragCancelled && (beyond(contact, event, contact.radius) ||
          event.getCoalescedEvents?.().some(sample => beyond(contact, sample, contact.radius)))) cancelTouchDrag(contact);
      event.preventDefault();
    } else if (beyond(contact, event, gesture.held() ? 90 : 20)) {
      if (gesture.held()) rememberRelease(contact, true);
      gesture.abort(); point = undefined;
    } else if (gesture.held()) event.preventDefault();
  };
  const onClick = event => {
    if (!isEcho(event, event.target?.closest?.('button'))) return;
    const { blockClick } = echo;
    echo = undefined;
    if (blockClick) consume(event);
  };
  const onContext = event => {
    if ((point?.touch && (event.target?.closest?.('button') === point.button || event.pointerId === point.id)) ||
        (gesture.held() && nativeButton(event))) consume(event);
  };
  const onFocus = event => { if (isEditor(event.target)) focus(); };
  const onKeyDown = event => { if (isEditor(event.target)) focus(); };
  const onMouseDown = event => {
    // Fallback for compatibility events a browser still emits: native
    // keepDraftFocus() would unconditionally open a previously closed keyboard.
    const button = event.target?.closest?.('button');
    if (event.button === 0 && button && (button === point?.button || isEcho(event, button))) consume(event);
  };
  const abort = () => {
    const contact = point;
    point = undefined;
    if (contact && (contact.touch || gesture.held())) rememberRelease(contact, true);
    gesture.abort(); focus();
    if (contact) report(contact, contact.dragCancelled ? 'drag-cancelled' : 'interrupted');
  };
  const onPointerCancel = event => { if (point && event.pointerId === point.id) abort(); };
  const onVisibility = () => { if (doc.visibilityState !== 'visible') abort(); };
  const offState = input.state.subscribe(changed);
  const rows = [['pointerdown', onDown], ['pointerup', onUp], ['pointermove', onMove], ['click', onClick], ['contextmenu', onContext], ['focusin', onFocus], ['keydown', onKeyDown], ['mousedown', onMouseDown], ['pointercancel', onPointerCancel], ['visibilitychange', onVisibility]];
  for (const [name, callback] of rows) doc.addEventListener(name, callback, { capture: true, passive: false });
  win.addEventListener('blur', abort);
  return () => {
    gesture.dispose();
    offState();
    for (const [name, callback] of rows) doc.removeEventListener(name, callback, true);
    win.removeEventListener('blur', abort);
  };
}


// DSH 0.2.2-rc.3 compatibility: only the public, matched PendingQuestion carrier.
// No Client-package runtime imports, DOM discovery, Host mutations, or question auto-send.
const QUESTION_DRAFT_PREFIX = 'local-parakeet.question-drafts.v1:';

function questionRecommended(label) {
  const suffix = /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i;
  return { label: String(label).replace(suffix, ''), recommended: suffix.test(String(label)) };
}

function questionFingerprint(questions) {
  return JSON.stringify(questions.map(q => ({
    id: q.id, question: q.question, header: q.header, detail: q.detail,
    options: q.options ?? [], multiSelect: q.multiSelect === true,
  })));
}

function questionStorageKey(pending) {
  return QUESTION_DRAFT_PREFIX + JSON.stringify([pending.sessionId, pending.key]);
}

function questionInitialProgress(questions) {
  return {
    index: 0,
    drafts: questions.map(q => ({
      selected: (q.multiSelect ? (q.options ?? []) : (q.options ?? []).slice(0, 1))
        .filter(option => questionRecommended(option.label).recommended).map(option => option.label),
      custom: '', skipped: false,
    })),
  };
}

function questionValidProgress(progress, questions) {
  if (!progress || !Number.isInteger(progress.index) || progress.index < 0 || progress.index >= questions.length ||
      !Array.isArray(progress.drafts) || progress.drafts.length !== questions.length ||
      (progress.wait !== undefined && !['editing', 'waiting'].includes(progress.wait))) return false;
  return progress.drafts.every((draft, index) => {
    if (!draft || !Array.isArray(draft.selected) || typeof draft.custom !== 'string' || typeof draft.skipped !== 'boolean') return false;
    const labels = (questions[index].options ?? []).map(option => option.label);
    if (draft.selected.some(label => typeof label !== 'string' || !labels.includes(label)) ||
        new Set(draft.selected).size !== draft.selected.length) return false;
    if (!questions[index].multiSelect && (draft.selected.length > 1 || (draft.custom !== '' && draft.selected.length > 0))) return false;
    return !draft.skipped || (draft.custom === '' && draft.selected.length === 0);
  });
}

function questionAnswered(draft) {
  return draft.selected.length > 0 || draft.custom.trim() !== '';
}

function questionAnswerBatch(questions, progress) {
  if (!questionValidProgress(progress, questions)) throw new Error('Invalid question draft');
  const missing = progress.drafts.findIndex(draft => !draft.skipped && !questionAnswered(draft));
  if (missing >= 0) {
    const error = new Error('Question is incomplete');
    error.code = 'QUESTION_INCOMPLETE';
    error.index = missing;
    throw error;
  }
  return { answers: questions.map((question, index) => {
    const draft = progress.drafts[index];
    if (draft.skipped) return { id: question.id, selected: [] };
    const custom = draft.custom.trim();
    return {
      id: question.id,
      selected: custom === '' || question.multiSelect === true ? [...draft.selected] : [],
      ...(custom === '' ? {} : { custom }),
    };
  }) };
}

function selectVoiceQuestion(owner) {
  const pending = owner?.pendingInteraction;
  if (!owner?.sessionId || !pending || pending.sessionId !== owner.sessionId || pending.kind !== 'question' ||
      typeof pending.key !== 'string' || pending.review !== undefined || !Array.isArray(pending.questions) || pending.questions.length === 0) return null;
  if (pending.questions.some(q => !q || typeof q.id !== 'string' || typeof q.question !== 'string' || q.intent !== undefined ||
      (q.options !== undefined && (!Array.isArray(q.options) || q.options.some(o => !o || typeof o.label !== 'string'))))) return null;
  if (new Set(pending.questions.map(q => q.id)).size !== pending.questions.length) return null;
  for (const method of ['getSnapshot', 'subscribe', 'answer', 'dismiss', 'holdFocus', 'releaseFocus', 'engage', 'takeTime']) {
    if (typeof pending[method] !== 'function') return null;
  }
  try { return pending.getSnapshot()?.closed === false ? pending : null; } catch { return null; }
}

// Own namespace deliberately does not impersonate dsh.user-questions.drafts.v1.
// Native unsubmitted drafts do not migrate automatically; closing this presentation
// retains its own request-fingerprinted draft and leaves native storage untouched.
function createQuestionDraftController(pending, { storage } = {}) {
  let progress = questionInitialProgress(pending.questions);
  let phase = 'plain';
  let disposed = false;
  let navigationVersion = 0;
  const revisions = pending.questions.map(() => 0);
  const listeners = new Set();
  const key = questionStorageKey(pending);
  const fingerprint = questionFingerprint(pending.questions);
  try {
    const saved = JSON.parse(storage?.getItem(key) ?? 'null');
    if (saved?.version === 1 && saved.fingerprint === fingerprint && questionValidProgress(saved.progress, pending.questions)) {
      progress = saved.progress;
    }
  } catch { /* Storage is optional; the in-memory draft remains usable. */ }
  let stateSnapshot = { progress, phase };
  const emit = () => {
    stateSnapshot = { progress, phase };
    for (const listener of [...listeners]) listener();
  };
  const persist = () => {
    try { storage?.setItem(key, JSON.stringify({ version: 1, fingerprint, progress })); } catch { /* Memory fallback. */ }
  };
  const live = () => !disposed && pending.getSnapshot()?.closed === false;
  const write = (next, engage = false) => {
    if (!live() || phase !== 'plain' || !questionValidProgress(next, pending.questions)) return false;
    if (engage) {
      pending.engage();
      next = { ...next, wait: progress.wait ?? 'editing' };
    }
    for (let index = 0; index < revisions.length; index += 1) {
      if (next.drafts[index].custom !== progress.drafts[index].custom) revisions[index] += 1;
    }
    if (next.index !== progress.index) navigationVersion += 1;
    progress = next;
    persist();
    emit();
    return true;
  };
  const controller = {
    pending,
    getProgress: () => progress,
    getSnapshot: () => stateSnapshot,
    getPhase: () => phase,
    activate() { if (disposed) { disposed = false; emit(); } },
    revision: index => revisions[index],
    navigationVersion: () => navigationVersion,
    live,
    ready: () => live() && ['waterfall', 'rpc'].includes(pending.getSnapshot().channel),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    resumeWait() {
      if (progress.wait === 'waiting') pending.takeTime();
      else if (progress.wait === 'editing') pending.engage();
    },
    setPhase(next) { if (disposed || phase === next) return; phase = next; emit(); },
    custom(index, text) {
      if (index !== progress.index || typeof text !== 'string') return false;
      const current = progress.drafts[index];
      if (current.custom === text) return live() && phase === 'plain';
      return write({ ...progress, drafts: progress.drafts.map((draft, i) => i === index ? {
        selected: pending.questions[index].multiSelect ? [...draft.selected] : [], custom: text, skipped: false,
      } : draft) }, true);
    },
    choose(label) {
      const index = progress.index;
      const question = pending.questions[index];
      if (!(question.options ?? []).some(option => option.label === label)) return false;
      const current = progress.drafts[index];
      const draft = question.multiSelect ? {
        ...current, skipped: false,
        selected: current.selected.includes(label) ? current.selected.filter(item => item !== label) : [...current.selected, label],
      } : { selected: [label], custom: '', skipped: false };
      return write({ ...progress,
        index: !question.multiSelect && index < pending.questions.length - 1 ? index + 1 : index,
        drafts: progress.drafts.map((item, i) => i === index ? draft : item),
      }, true);
    },
    navigate(index) {
      if (!Number.isInteger(index) || index < 0 || index >= pending.questions.length) return false;
      return write({ ...progress, index });
    },
    skip() {
      const index = progress.index;
      return write({ ...progress,
        index: Math.min(index + 1, pending.questions.length - 1),
        drafts: progress.drafts.map((draft, i) => i === index ? { selected: [], custom: '', skipped: true } : draft),
      }, true);
    },
    takeTime() {
      if (!live()) return;
      pending.takeTime();
      progress = { ...progress, wait: 'waiting' };
      persist(); emit();
    },
    clear() { try { storage?.removeItem(key); } catch { /* Memory remains scoped to this mount. */ } },
    dispose() { disposed = true; emit(); listeners.clear(); },
  };
  return controller;
}

let qvFieldGeneration = 0;
function createQuestionField(controller, { readSelection, onSubmit, notify } = {}) {
  const index = controller.getProgress().index;
  const navigationVersion = controller.navigationVersion();
  const pending = controller.pending;
  const generation = ++qvFieldGeneration;
  const targetKey = 'local-parakeet:question:' + JSON.stringify([pending.sessionId, pending.key, pending.questions[index].id, generation]);
  let disposed = false;
  let cached;
  const localListeners = new Set();
  const current = () => !disposed && controller.live() && controller.getProgress().index === index && controller.navigationVersion() === navigationVersion;
  const snapshot = () => {
    const draft = controller.getProgress().drafts[index].custom;
    const draftRev = controller.revision(index);
    const phase = current() && controller.ready() ? controller.getPhase() : 'submitting';
    if (!cached || cached.draft !== draft || cached.draftRev !== draftRev || cached.phase !== phase) {
      cached = { draft, draftRev, phase, occurrences: [] };
    }
    return cached;
  };
  const input = {
    targetKind: 'question',
    state: {
      getSnapshot: snapshot,
      subscribe(listener) { localListeners.add(listener); return () => localListeners.delete(listener); },
    },
    submit(...args) { if (current() && controller.getPhase() === 'plain') return onSubmit?.(...args); },
    notify(level, text) { if (current()) notify?.(level, text); },
  };
  const publish = () => { for (const listener of [...localListeners]) listener(); };
  let unsubscribe = controller.subscribe(publish);
  const captureInsertion = () => {
    const state = snapshot();
    if (state.phase !== 'plain') return undefined;
    const selection = readSelection?.();
    const start = Math.max(0, Math.min(state.draft.length, Number.isInteger(selection?.start) ? selection.start : state.draft.length));
    const end = Math.max(start, Math.min(state.draft.length, Number.isInteger(selection?.end) ? selection.end : start));
    return { start, end, draftRev: state.draftRev };
  };
  const actions = {
    captureInsertion,
    setDraft(text) { return current() && snapshot().phase === 'plain' && controller.custom(index, text); },
    insertText(text, span) {
      const state = snapshot();
      if (!current() || state.phase !== 'plain' || typeof text !== 'string' || !span || span.draftRev !== state.draftRev ||
          !Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < 0 || span.end < span.start || span.end > state.draft.length) return false;
      return controller.custom(index, state.draft.slice(0, span.start) + text + state.draft.slice(span.end));
    },
    submit(...args) { return input.submit(...args); },
  };
  return {
    targetKey, input, inputActions: actions,
    resolveInput: id => id === targetKey && current() && controller.ready() && controller.getPhase() === 'plain' ? input : undefined,
    activate() {
      if (!disposed) return;
      disposed = false;
      unsubscribe = controller.subscribe(publish);
      publish();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      for (const listener of [...localListeners]) listener();
      localListeners.clear();
    },
  };
}

const qvCopy = {
  en: { title: 'Questions', other: 'Other / free response', placeholder: 'Type or dictate your answer', next: 'Next', submit: 'Submit answers', skip: 'Skip', prev: 'Previous question', following: 'Next question', close: 'Close questions', minimize: 'Minimize', expand: 'Expand', recommended: 'Recommended', takeTime: 'Take time', paused: 'Paused · {seconds}s', counting: '{seconds}s remaining', held: 'Take your time', continued: 'Agent continued · you can still answer', waiting: 'Connecting answer channel…', incomplete: 'Answer or skip every question before submitting.', unanswered: 'Enter an answer or skip this question.', unavailable: 'The question is no longer ready for an answer.', resubmit: 'The agent continued. Review and submit the answers again.', sent: 'Answers sent; waiting for confirmation…', hint: 'Dictation only edits this answer. Submit answers yourself.', detail: 'Question details', voice: 'Dictate this answer' },
  ru: { title: 'Вопросы', other: 'Другое / свободный ответ', placeholder: 'Введите или надиктуйте ответ', next: 'Далее', submit: 'Отправить ответы', skip: 'Пропустить', prev: 'Предыдущий вопрос', following: 'Следующий вопрос', close: 'Закрыть вопросы', minimize: 'Свернуть', expand: 'Развернуть', recommended: 'Рекомендуется', takeTime: 'Не торопиться', paused: 'Пауза · {seconds} с', counting: 'Осталось {seconds} с', held: 'Можно не торопиться', continued: 'Агент продолжил работу · ответить ещё можно', waiting: 'Подключение канала ответа…', incomplete: 'Ответьте на каждый вопрос или пропустите его.', unanswered: 'Введите ответ или пропустите вопрос.', unavailable: 'Вопрос пока не готов принять ответ или уже закрыт.', resubmit: 'Агент продолжил работу. Проверьте и отправьте ответы ещё раз.', sent: 'Ответы отправлены; ждём подтверждения…', hint: 'Диктовка меняет только этот ответ. Отправка — вручную.', detail: 'Подробности вопроса', voice: 'Надиктовать этот ответ' },
  zh: { title: '问题', other: '其他 / 自由回答', placeholder: '输入或听写回答', next: '下一步', submit: '提交回答', skip: '跳过', prev: '上一题', following: '下一题', close: '关闭问题', minimize: '收起', expand: '展开', recommended: '推荐', takeTime: '慢慢回答', paused: '已暂停 · {seconds} 秒', counting: '剩余 {seconds} 秒', held: '可以慢慢回答', continued: '助手已继续，仍可回答', waiting: '正在连接回答通道…', incomplete: '请回答或跳过每个问题后再提交。', unanswered: '请输入回答或跳过此题。', unavailable: '问题尚未准备好接收回答或已关闭。', resubmit: '助手已继续。请检查并重新提交回答。', sent: '回答已发送，正在等待确认…', hint: '听写只编辑当前回答。请手动提交回答。', detail: '问题详情', voice: '听写此回答' },
};
const qvFallbackLocale = { active: 'en', revision: 0 };
const qvStyle = `
.dsh-lpq-frame{display:flex;justify-content:center;padding:6px calc(var(--dsh-composer-side-clearance,12px) + 16px) 10px;color:var(--dsw-alias-label-primary)}
.dsh-lpq-card{box-sizing:border-box;display:flex;flex-direction:column;width:100%;max-width:var(--dsh-chat-content-width,760px);max-height:min(60vh,520px);border:1px solid var(--dsw-alias-border-l1);border-radius:16px;background:var(--dsw-alias-bg-layer-2);font:inherit;overflow:hidden}
.dsh-lpq-card *{box-sizing:border-box}.dsh-lpq-header,.dsh-lpq-footer{display:flex;align-items:center;gap:8px;padding:12px 16px;flex:none;flex-wrap:wrap}.dsh-lpq-header{border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsh-lpq-heading{font-size:12px;color:var(--dsw-alias-label-secondary);margin-right:auto}.dsh-lpq-body{padding:12px 16px;overflow:auto;min-height:0;display:flex;flex-direction:column;gap:12px}.dsh-lpq-title{font-size:16px;line-height:22px;margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.dsh-lpq-detail{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:20px}
.dsh-lpq-choices{display:flex;flex-direction:column;gap:6px}.dsh-lpq-choice{display:flex;align-items:flex-start;gap:10px;min-height:40px;width:100%;text-align:left;padding:8px 10px}.dsh-lpq-choice[aria-checked=true]{border-color:var(--dsw-alias-brand-primary)}.dsh-lpq-choice-copy{display:flex;flex-direction:column;gap:3px;min-width:0;overflow-wrap:anywhere;white-space:pre-wrap}.dsh-lpq-description,.dsh-lpq-hint,.dsh-lpq-countdown{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}.dsh-lpq-badge{font-size:11px;color:var(--dsw-alias-brand-primary);margin-left:8px}.dsh-lpq-text{display:flex;flex-direction:column;gap:6px}.dsh-lpq-text label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsh-lpq-answer-row{display:flex;gap:8px;align-items:flex-end}.dsh-lpq-answer{flex:1;min-width:0;min-height:54px;max-height:180px;resize:vertical;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;color:inherit;font:inherit;line-height:22px;padding:8px}.dsh-lpq-mic{padding:0;margin:0;min-width:28px;border:0}.dsh-lpq-footer{border-top:1px solid var(--dsw-alias-border-l1)}.dsh-lpq-pager{display:flex;gap:8px;align-items:center}.dsh-lpq-feedback{font-size:12px;line-height:18px;flex:1 1 160px;overflow-wrap:anywhere}.dsh-lpq-button{appearance:none;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:13px;line-height:20px;padding:5px 10px;cursor:pointer}.dsh-lpq-button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}.dsh-lpq-button:focus-visible,.dsh-lpq-answer:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.dsh-lpq-button:disabled{opacity:.5;cursor:default}.dsh-lpq-primary{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);border-color:transparent}.dsh-lpq-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary)}
@media(pointer:coarse){.dsh-lpq-answer{font-size:max(16px,1em)}.dsh-lpq-button{min-height:36px}}@media(max-width:480px){.dsh-lpq-frame{padding-left:12px;padding-right:12px}.dsh-lpq-header,.dsh-lpq-footer{padding:10px 12px}.dsh-lpq-body{padding:10px 12px}}
`;

function createQuestionVoice(React, { MicButton, StatusRow, locale, controls }) {
  const h = React.createElement;
  const { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } = React;
  function QuestionCard({ pending }) {
    const [model] = useState(() => {
      let storage;
      try { storage = globalThis.localStorage; } catch { /* Optional browser storage. */ }
      return createQuestionDraftController(pending, { storage });
    });
    const modelState = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
    const progress = modelState.progress;
    const navigationVersion = model.navigationVersion();
    const readCard = useCallback(() => pending.getSnapshot(), [pending]);
    const subCard = useCallback(listener => pending.subscribe(listener), [pending]);
    const card = useSyncExternalStore(subCard, readCard, readCard);
    const subLocale = useCallback(listener => locale?.subscribe?.(listener) ?? (() => {}), []);
    const readLocale = useCallback(() => locale?.getSnapshot?.() ?? locale?.getLocale?.() ?? qvFallbackLocale, []);
    const localeState = useSyncExternalStore(subLocale, readLocale, readLocale);
    const t = (key, vars = {}) => {
      const texts = { en: qvCopy.en[key], ru: qvCopy.ru[key], zh: qvCopy.zh[key] };
      const translated = locale?.bind?.('local-parakeet.question')?.(key);
      let text = translated && translated !== key ? translated : qvCopy[String(localeState.active ?? 'en').split('-')[0]]?.[key] ?? texts.en;
      for (const [name, value] of Object.entries(vars)) text = text.replaceAll(`{${name}}`, String(value));
      return text;
    };
    const [feedback, setFeedback] = useState(null);
    const [minimized, setMinimized] = useState(false);
    const [transitioning, setTransitioning] = useState(false);
    const [voiceActive, setVoiceActive] = useState(false);
    const textarea = useRef(null);
    const body = useRef(null);
    const surface = useRef(null);
    const voiceActiveRef = useRef(false);
    const occurrenceId = useId();
    const alive = useRef(true);
    const actionLock = useRef(false);
    const sentVia = useRef(null);
    const actionRef = useRef(null);
    const field = useMemo(() => createQuestionField(model, {
      readSelection: () => ({ start: textarea.current?.selectionStart, end: textarea.current?.selectionEnd }),
      onSubmit: action => actionRef.current?.(action),
      notify: (_level, text) => { if (alive.current) setFeedback({ text }); },
    }), [model, progress.index, navigationVersion]);
    const fieldRef = useRef(field);
    fieldRef.current = field;
    const phase = model.getPhase();
    const locked = phase !== 'plain' || transitioning;
    const question = pending.questions[progress.index];
    const draft = progress.drafts[progress.index];
    const canAnswer = card.channel !== 'none' && !card.closed;
    const current = () => alive.current && model.live() && fieldRef.current === field;
    const cancelCapture = async () => {
      const control = controls.get(field.targetKey);
      await control?.cancel?.();
      control?.discard?.();
    };
    const abandonThen = async action => {
      if (actionLock.current || locked || !current()) return;
      actionLock.current = true;
      setTransitioning(true);
      try {
        await cancelCapture();
        if (current()) await action();
      } catch (error) {
        if (current()) setFeedback({ text: error?.message ?? String(error) });
      } finally {
        actionLock.current = false;
        if (alive.current) setTransitioning(false);
      }
    };
    const send = async () => {
      if (!current() || model.getPhase() !== 'plain') return;
      let answer;
      try { answer = questionAnswerBatch(pending.questions, model.getProgress()); }
      catch (error) {
        if (error.code === 'QUESTION_INCOMPLETE') { model.navigate(error.index); setFeedback({ key: 'incomplete' }); return; }
        setFeedback({ text: error.message }); return;
      }
      if (!model.ready()) { setFeedback({ key: 'unavailable' }); return; }
      sentVia.current = pending.getSnapshot().channel;
      model.setPhase('submitting');
      setFeedback({ key: 'sent' });
      try {
        await pending.answer(answer);
        if (!alive.current || !model.live()) return;
        if (sentVia.current === 'rpc') {
          model.setPhase('plain');
          await pending.dismiss();
        }
      } catch (error) {
        if (!alive.current || !model.live()) return;
        sentVia.current = null;
        model.setPhase('plain');
        setFeedback({ text: error?.message ?? String(error) });
      }
    };
    actionRef.current = action => {
      if (!current() || model.getPhase() !== 'plain' || !action || typeof action !== 'object') return;
      setFeedback(null);
      const latest = model.getProgress();
      if (action.kind === 'navigate') model.navigate(action.index);
      else if (action.kind === 'submit') void send();
      else if (action.kind === 'continue') {
        if (!questionAnswered(latest.drafts[latest.index])) { setFeedback({ key: 'unanswered' }); return; }
        if (latest.index < pending.questions.length - 1) model.navigate(latest.index + 1);
        else void send();
      }
    };
    const useVirtualInput = selector => {
      const state = useSyncExternalStore(field.input.state.subscribe, field.input.state.getSnapshot, field.input.state.getSnapshot);
      return selector(state);
    };
    useEffect(() => {
      alive.current = true;
      model.activate();
      model.resumeWait();
      return () => {
        alive.current = false;
        pending.releaseFocus();
        if (pending.getSnapshot().closed) model.clear();
        model.dispose();
      };
    }, [model, pending]);
    useEffect(() => {
      // The underlying native composer remains mounted beneath this takeover.
      // A sentinel disables its global dictation shortcuts without reading its DOM.
      const marker = { questionSession: pending.sessionId };
      const key = `question-surface:${pending.sessionId}:${pending.key}:${occurrenceId}`;
      controls.set(key, marker);
      void Promise.resolve(controls.get(pending.sessionId)?.cancel?.()).catch(() => {});
      return () => { if (controls.get(key) === marker) controls.delete(key); };
    }, [pending, occurrenceId]);
    useEffect(() => {
      if (!card.closed) return;
      model.clear();
      field.dispose();
      void controls.get(field.targetKey)?.cancel?.();
      controls.get(field.targetKey)?.discard?.();
    }, [card.closed, field, model]);
    useEffect(() => {
      if (sentVia.current === 'waterfall' && card.state === 'continued') {
        sentVia.current = null;
        model.setPhase('plain');
        setFeedback({ key: 'resubmit' });
      }
    }, [card.state, model]);
    useEffect(() => {
      field.activate();
      if (body.current) body.current.scrollTop = 0;
      return () => {
        field.dispose();
        void controls.get(field.targetKey)?.cancel?.();
        controls.get(field.targetKey)?.discard?.();
      };
    }, [field]);
    useEffect(() => {
      const release = () => pending.releaseFocus();
      const refocus = () => {
        if (voiceActiveRef.current || surface.current?.contains(document.activeElement)) pending.holdFocus();
      };
      const visibility = () => { if (document.hidden) release(); else refocus(); };
      window.addEventListener('blur', release);
      window.addEventListener('focus', refocus);
      document.addEventListener('visibilitychange', visibility);
      return () => {
        window.removeEventListener('blur', release);
        window.removeEventListener('focus', refocus);
        document.removeEventListener('visibilitychange', visibility);
      };
    }, [pending]);
    if (card.closed) return null;
    const button = (label, props = {}) => h('button', { type: 'button', className: 'dsh-lpq-button', disabled: locked, ...props }, label);
    let wait = '';
    if (card.state === 'continued') wait = t('continued');
    else if (['waiting', 'editing'].includes(card.waitState)) wait = t('held');
    else if (card.countdown) wait = t(card.countdown.running ? 'counting' : 'paused', { seconds: Math.ceil(card.countdown.remainingMs / 1000) });
    else if (!canAnswer) wait = t('waiting');
    const titleId = 'dsh-lpq-' + encodeURIComponent(occurrenceId) + '-' + progress.index;
    return h('div', { className: 'dsh-lpq-frame', 'data-local-parakeet-question': pending.key },
      h('style', null, qvStyle),
      h('section', {
        ref: surface, className: 'dsh-lpq-card', 'aria-labelledby': titleId, 'aria-busy': phase !== 'plain',
        onFocusCapture: event => { if (!event.currentTarget.contains(event.relatedTarget)) pending.holdFocus(); },
        onBlurCapture: event => { if (!event.currentTarget.contains(event.relatedTarget) && !voiceActive) pending.releaseFocus(); },
      },
      h('header', { className: 'dsh-lpq-header' },
        h('span', { className: 'dsh-lpq-heading' }, question.header ?? t('title')),
        wait ? h('span', { className: 'dsh-lpq-countdown', role: 'status' }, wait) : null,
        card.countdown && ['counting', 'focused'].includes(card.waitState) ? button(t('takeTime'), { onClick: () => model.takeTime() }) : null,
        button(minimized ? '⌄' : '⌃', { 'aria-label': t(minimized ? 'expand' : 'minimize'), 'aria-expanded': !minimized, onClick: () => { void abandonThen(() => setMinimized(value => !value)); } }),
        button('×', { 'aria-label': t('close'), onClick: () => { void abandonThen(() => pending.dismiss()); } })),
      minimized ? h('h2', { className: 'dsh-lpq-title', id: titleId, style: { padding: '12px 16px' } }, question.question) : h(React.Fragment, null,
        h('div', { className: 'dsh-lpq-body', ref: body },
          h('h2', { className: 'dsh-lpq-title', id: titleId }, question.question),
          question.detail ? h('details', { className: 'dsh-lpq-detail', key: question.id }, h('summary', null, t('detail')), h('div', null, question.detail)) : null,
          (question.options ?? []).length > 0 ? h('div', { className: 'dsh-lpq-choices', role: question.multiSelect ? 'group' : 'radiogroup', 'aria-labelledby': titleId },
            ...question.options.map((option, index) => {
              const display = questionRecommended(option.label);
              const selected = draft.selected.includes(option.label);
              return h('button', {
                key: index, type: 'button', className: 'dsh-lpq-button dsh-lpq-choice', role: question.multiSelect ? 'checkbox' : 'radio',
                'aria-checked': selected, disabled: locked,
                onClick: () => { void abandonThen(() => { model.choose(option.label); setFeedback(null); }); },
                onKeyDown: event => { if (event.key === 'Enter' && !event.nativeEvent?.isComposing) { event.preventDefault(); field.input.submit({ kind: 'submit' }); } },
              }, h('span', { 'aria-hidden': true }, question.multiSelect ? (selected ? '☑' : '☐') : String(index + 1)),
              h('span', { className: 'dsh-lpq-choice-copy' }, h('span', null, display.label, display.recommended ? h('span', { className: 'dsh-lpq-badge' }, t('recommended')) : null),
                option.description ? h('span', { className: 'dsh-lpq-description' }, option.description) : null));
            })) : null,
          h('div', { className: 'dsh-lpq-text' },
            h('label', { htmlFor: titleId + '-answer' }, t('other')),
            h('div', { className: 'dsh-lpq-answer-row' },
              h('textarea', {
                ref: textarea, id: titleId + '-answer', className: 'dsh-lpq-answer', value: draft.custom, placeholder: t('placeholder'), disabled: locked, rows: 2,
                onChange: event => { model.custom(progress.index, event.target.value); setFeedback(null); },
                onKeyDown: event => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing && event.nativeEvent?.keyCode !== 229) {
                    event.preventDefault(); field.input.submit({ kind: 'continue' });
                  }
                },
              }),
              h('fieldset', { className: 'dsh-lpq-mic', disabled: locked || !canAnswer, 'aria-label': t('voice') },
                canAnswer ? h(MicButton, {
                  key: field.targetKey, sessionId: field.targetKey, inputActions: field.inputActions, resolveInput: field.resolveInput, locale,
                  useInput: useVirtualInput, targetKind: 'question', micLabel: t('voice'),
                  onActiveChange: active => {
                    voiceActiveRef.current = active;
                    if (alive.current) setVoiceActive(active);
                    if (active) pending.holdFocus();
                    else if (!surface.current?.contains(document.activeElement)) pending.releaseFocus();
                  },
                }) : null)),

            h('span', { className: 'dsh-lpq-hint' }, t('hint')),
            h(StatusRow, { key: field.targetKey, sessionId: field.targetKey, inputActions: field.inputActions, useInput: useVirtualInput, locale }))),
        h('footer', { className: 'dsh-lpq-footer' },
          h('div', { className: 'dsh-lpq-pager' },
            button('‹', { 'aria-label': t('prev'), disabled: locked || progress.index === 0, onClick: () => field.input.submit({ kind: 'navigate', index: progress.index - 1 }) }),
            h('span', null, `${progress.index + 1} / ${pending.questions.length}`),
            button('›', { 'aria-label': t('following'), disabled: locked || progress.index === pending.questions.length - 1, onClick: () => field.input.submit({ kind: 'navigate', index: progress.index + 1 }) })),
          h('span', { className: 'dsh-lpq-feedback', role: 'status' }, feedback ? (feedback.key ? t(feedback.key) : feedback.text) : ''),
          button(t('skip'), { onClick: () => { void abandonThen(async () => { const last = model.getProgress().index === pending.questions.length - 1; model.skip(); setFeedback(null); if (last) await send(); }); } }),
          button(t(progress.index === pending.questions.length - 1 ? 'submit' : 'next'), {
            className: 'dsh-lpq-button dsh-lpq-primary',
            disabled: locked || (!questionAnswered(draft) && !voiceActive) || (progress.index === pending.questions.length - 1 && !canAnswer),
            onClick: () => field.input.submit({ kind: 'continue' }),
          })))));
  }
  function Component({ matched, sessionId }) {
    if (matched?.sessionId !== sessionId) return null;
    return h(QuestionCard, { key: matched.key, pending: matched });
  }
  return { select: selectVoiceQuestion, Component };
}


// Self-contained browser feature: compiler inlines this beside preserved capture code.
function captureHeaders(rec,phase,{segment=null,attempt=0}={}){
 if(!rec.takeId||!Number.isSafeInteger(rec.generation))throw new Error('capture identity unavailable');
 const sequence=phase==='final'?('final'+(segment===null?'':'.window.'+segment)+(attempt===0?'':'.retry.'+attempt)):String(++rec.requestSequence);
 return {'x-asr-phase':phase,'x-asr-utterance-id':rec.takeId,'x-asr-generation':String(rec.generation),'idempotency-key':rec.takeId+'.'+rec.generation+'.'+sequence};
}
function applyRigCopy(dicts){
 const copy={
  en:{'status.processing':'Transcribing…','error.empty':'No speech recognized.','error.notPrepared':'Rig interactive ASR is not ready.','error.preparing':'Rig GPU workers are warming.','prepare.title':'Qwen ASR 1.7B · Rig GPU','prepare.description':'Audio is compressed to FLAC on the DSH host, then sent over the private Tailnet to Rig GPU. No local ASR model is started.','prepare.sizeUnknown':'Model is hosted on Rig','prepare.hint':'Prepare requests the configured GPU pool. No model is downloaded here.','prepare.error':'Rig ASR is unavailable.','prepare.phase.checking':'Checking Rig readiness…','prepare.phase.installing':'Warming Rig GPU workers…','prepare.phase.downloading':'Warming Rig GPU workers…','prepare.phase.ready':'Rig interactive ASR is ready.','prepare.phase.error':'Rig readiness check failed.'},
  ru:{'status.processing':'Распознаю…','error.empty':'Речь не распознана.','error.notPrepared':'Интерактивный ASR на Rig не готов.','error.preparing':'GPU-воркеры Rig прогреваются.','prepare.title':'Qwen ASR 1.7B · Rig GPU','prepare.description':'DSH сжимает аудио в FLAC и передаёт по приватному Tailnet на GPU Rig. Локальная ASR-модель не запускается.','prepare.sizeUnknown':'Модель размещена на Rig','prepare.hint':'Подготовка запрашивает прогрев настроенного GPU-пула. Модель здесь не скачивается.','prepare.error':'Rig ASR недоступен.','prepare.phase.checking':'Проверяю готовность Rig…','prepare.phase.installing':'Прогреваются GPU-воркеры Rig…','prepare.phase.downloading':'Прогреваются GPU-воркеры Rig…','prepare.phase.ready':'Интерактивный ASR на Rig готов.','prepare.phase.error':'Проверка готовности Rig не удалась.'},
  zh:{'status.processing':'正在识别…','error.empty':'未识别到语音。','error.notPrepared':'Rig 交互识别尚未就绪。','error.preparing':'Rig GPU 正在预热。','prepare.title':'Qwen ASR 1.7B · Rig GPU','prepare.description':'DSH 将音频压缩为 FLAC，通过私有 Tailnet 发送到 Rig GPU；不启动本地识别模型。','prepare.sizeUnknown':'模型位于 Rig','prepare.hint':'准备操作请求 GPU 池预热，不在本地下载模型。','prepare.error':'Rig ASR 不可用。','prepare.phase.checking':'正在检查 Rig…','prepare.phase.installing':'正在预热 Rig GPU…','prepare.phase.downloading':'正在预热 Rig GPU…','prepare.phase.ready':'Rig 交互识别已就绪。','prepare.phase.error':'Rig 检查失败。'}
 };for(const locale of Object.keys(copy))Object.assign(dicts[locale],copy[locale]);
}
function createRigSettings(React,{api}){
 const h=React.createElement;
 return function RigSettings(){
  const [pool,setPool]=React.useState(null),[backend,setBackend]=React.useState(null),[status,setStatus]=React.useState(null),[error,setError]=React.useState(''),[busy,setBusy]=React.useState(false);
  const [bulk,setBulk]=React.useState('7'),[reserve,setReserve]=React.useState('1');const dirty=React.useRef(false),alive=React.useRef(true);
  async function refresh(){try{const [p,b,s]=await Promise.all([api('/pool'),api('/backend'),api('/status')]);if(!alive.current)return;setPool(p);setBackend(b);setStatus(s);if(!dirty.current){setBulk(String(p.config.bulk_workers??p.config.bulk_gpu_ids?.length??0));setReserve(String(p.config.interactive_workers??p.config.interactive_gpu_ids?.length??0))}setError('')}catch{if(alive.current)setError('Rig status unavailable; no local fallback.')}}
  React.useEffect(()=>{alive.current=true;void refresh();const timer=window.setInterval(()=>void refresh(),3000);return()=>{alive.current=false;window.clearInterval(timer)}},[]);
  async function mutate(path,body){setBusy(true);setError('');try{await api(path,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(body)});dirty.current=false;await refresh()}catch{if(alive.current)setError('Change refused or gateway unavailable; refresh before retrying.')}finally{if(alive.current)setBusy(false)}}
  const workers=pool?.workers??[],valid=/^\d+$/.test(bulk)&&/^\d+$/.test(reserve)&&Number(bulk)+Number(reserve)<=13;
  return h('section',{'aria-label':'Rig ASR pool',style:{padding:16,display:'grid',gap:12}},
   h('h2',null,'Qwen ASR 1.7B · Rig GPU'),h('p',null,'Private Tailnet · desired pool vs actual GPU worker state. Active jobs finish before draining.'),
   error&&h('p',{role:'alert'},error),
   h('p',{role:'status'},`Backend ${status?.backend??'unverified'} · ${status?.model??'unverified'} · ${status?.device??'unverified'} · ${status?.ready?'interactive ready':'not ready'}`),
   h('p',null,`Desired GPU lists: bulk ${(pool?.config.bulk_gpu_ids??[]).join(', ')||'none'}; interactive ${(pool?.config.interactive_gpu_ids??[]).join(', ')||'none'}`),
   h('label',null,'Backend ',h('select',{'aria-label':'ASR backend',value:backend?.backend??'rig',disabled:busy||!backend,onChange:e=>void mutate('/backend',{backend:e.target.value})},h('option',{value:'rig'},'Rig Qwen ASR'),h('option',{value:'local',disabled:!backend?.localEnabled},'Local Parakeet (disabled rollback)'))),
   h('label',null,'Bulk workers (desired) ',h('input',{type:'number',min:0,max:13,value:bulk,onChange:e=>{dirty.current=true;setBulk(e.target.value)}})),
   h('label',null,'Interactive reserve (desired) ',h('input',{type:'number',min:0,max:13,value:reserve,onChange:e=>{dirty.current=true;setReserve(e.target.value)}})),
   h('p',null,`Desired total: ${Number(bulk)+Number(reserve)} / 13 · actual ${workers.length} · ready ${workers.filter(w=>w.ready).length} · busy ${workers.filter(w=>w.busy).length} · draining ${workers.filter(w=>w.draining).length}`),
   h('div',null,h('button',{type:'button',disabled:busy||!valid||!pool,onClick:()=>void mutate('/pool',{bulk_workers:Number(bulk),interactive_workers:Number(reserve)})},'Apply pool'),h('button',{type:'button',disabled:busy||!pool,onClick:()=>void mutate('/pool',{bulk_workers:0,interactive_workers:Number(pool?.config.interactive_workers??1)})},'Drain bulk'),h('button',{type:'button',disabled:busy||!pool,onClick:()=>void mutate('/pool',{bulk_workers:0,interactive_workers:0})},'Drain all after active jobs'),h('button',{type:'button',disabled:busy,onClick:()=>void refresh()},'Refresh')),
   h('p',null,`Queued: bulk ${pool?.queue.bulk??0}, interactive ${pool?.queue.interactive??0}`),
   h('ul',null,...workers.map(w=>h('li',{key:w.worker_id},`GPU ${w.gpu} · ${w.role} · ${w.state}${w.draining?' · draining':''}${w.error?' · unavailable':''}`)))
  );
 };
}


const MICROPHONE_PREFERENCE_KEY = 'local-parakeet.microphone.v1';

function isPhysicalInput(id) {
  // Chromium's default and communications entries are OS aliases, not pins.
  return typeof id === 'string' && id.length > 0 && id !== 'default' && id !== 'communications';
}

function microphoneCatalog(entries) {
  const devices = new Map();
  let defaultLabel = '';
  let hidden = false;
  for (const { kind, deviceId, label } of entries) {
    if (kind !== 'audioinput') continue;
    const name = label?.trim() || '';
    if (deviceId === 'default') { defaultLabel = name; hidden ||= !name; continue; }
    if (deviceId === 'communications') continue;
    if (!isPhysicalInput(deviceId) || !name) { hidden = true; continue; }
    if (!devices.has(deviceId)) devices.set(deviceId, name);
  }
  const counts = new Map();
  const positions = new Map();
  for (const name of devices.values()) counts.set(name, (counts.get(name) ?? 0) + 1);
  const inputs = [...devices].map(([id, name]) => {
    if (counts.get(name) === 1) return { id, label: name };
    const index = (positions.get(name) ?? 0) + 1;
    positions.set(name, index);
    return { id, label: `${name} (${index})` };
  });
  return { inputs, defaultLabel, hidden };
}

function microphoneCaptureError(error, pinned) {
  switch (error?.name) {
    case 'NotAllowedError': case 'PermissionDeniedError': case 'SecurityError':
      return 'error.micDenied';
    case 'NotFoundError': case 'DevicesNotFoundError': case 'OverconstrainedError': case 'ConstraintNotSatisfiedError':
      return pinned ? 'error.micSelectedMissing' : 'error.micMissing';
    case 'NotReadableError': case 'TrackStartError': case 'AbortError':
      return 'error.micBusy';
    default:
      return 'error.micOpen';
  }
}

function stopMicrophoneTracks(stream) {
  for (const track of stream?.getTracks() ?? []) {
    try { track.stop(); } catch { /* Already stopped. */ }
  }
}

async function openMicrophone(media, preference) {
  if (typeof media?.getUserMedia !== 'function') throw new Error('error.micUnsupported');
  const audio = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  const id = preference?.id;
  if (preference != null) {
    if (!isPhysicalInput(id) || (typeof media.getSupportedConstraints === 'function' && !media.getSupportedConstraints().deviceId)) {
      throw new Error('error.micPinUnsupported');
    }
    audio.deviceId = { exact: id };
  }
  let stream;
  try {
    stream = await media.getUserMedia({ audio });
  } catch (error) {
    // Never retry a failed exact constraint with the system default.
    throw new Error(microphoneCaptureError(error, Boolean(id)));
  }
  try {
    const track = stream.getAudioTracks()[0];
    if (!track || track.readyState === 'ended') throw new Error(id ? 'error.micSelectedMissing' : 'error.micMissing');
    if (id) {
      const actualId = track.getSettings?.()?.deviceId;
      if (!actualId) throw new Error('error.micPinUnsupported');
      if (actualId !== id) throw new Error('error.micPinMismatch');
    }
    return { stream, label: track.label?.trim() || '' };
  } catch (error) {
    stopMicrophoneTracks(stream);
    throw error;
  }
}

function enumerateWhileAllowed(media, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    const cancel = () => finish(reject, new Error('cancelled'));
    const timer = setTimeout(() => finish(reject, new Error('error.micList')), timeoutMs);
    function finish(settle, value) {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      settle(value);
    }
    if (signal.aborted) { cancel(); return; }
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve().then(() => {
      if (!signal.aborted) return media.enumerateDevices();
    }).then(entries => finish(resolve, entries), () => finish(reject, new Error('error.micList')));
  });
}

function createMicrophoneSelection(media, getStorage, { probeTimeoutMs = 2500 } = {}) {
  const listeners = new Set();
  const enumerable = typeof media?.enumerateDevices === 'function';
  const canReveal = enumerable && typeof media?.getUserMedia === 'function';
  const empty = microphoneCatalog([]);
  let state = { preference: null, storageFailed: false, catalog: empty, status: 'idle', revealing: false, revealError: '' };
  let readSequence = 0;
  let probe = null;
  let disposed = false;
  function publish(patch) {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }
  function loadPreference() {
    try {
      const stored = getStorage().getItem(MICROPHONE_PREFERENCE_KEY);
      let parsed;
      try { parsed = stored && JSON.parse(stored); } catch { /* Ignore an obsolete value. */ }
      publish({ preference: isPhysicalInput(parsed?.id) && typeof parsed.label === 'string' ? { id: parsed.id, label: parsed.label } : null });
    } catch { /* The in-memory choice remains usable even if storage is blocked. */ }
  }
  loadPreference();

  async function refresh() {
    if (disposed || probe) return;
    const sequence = ++readSequence;
    if (!enumerable) { publish({ status: 'unsupported' }); return; }
    if (state.status !== 'ready') publish({ status: 'loading' });
    try {
      const catalog = microphoneCatalog(await media.enumerateDevices());
      if (sequence === readSequence && !disposed) publish({ catalog, status: 'ready' });
    } catch {
      if (sequence === readSequence && !disposed) publish({ catalog: empty, status: 'error' });
    }
  }

  async function reveal(owner) {
    if (disposed || probe || !canReveal) return;
    const run = { owner, abort: new AbortController() };
    probe = run;
    ++readSequence;
    publish({ revealing: true, revealError: '' });
    let stream;
    try {
      // The user explicitly requested device names. No audio samples are read or sent.
      try { stream = await media.getUserMedia({ audio: true }); }
      catch (error) { throw new Error(microphoneCaptureError(error, false)); }
      if (run.abort.signal.aborted) return;
      const catalog = microphoneCatalog(await enumerateWhileAllowed(media, run.abort.signal, probeTimeoutMs));
      if (probe === run) publish({ catalog, status: 'ready', revealError: catalog.inputs.length ? '' : 'mic.namesUnavailable' });
    } catch (error) {
      if (probe === run) publish({ revealError: error.message });
    } finally {
      stopMicrophoneTracks(stream);
      if (probe === run) { probe = null; publish({ revealing: false }); }
    }
  }

  function cancelReveal(owner) {
    if (!probe || probe.owner !== owner) return;
    const run = probe;
    probe = null;
    run.abort.abort();
    publish({ revealing: false, status: state.status === 'loading' ? 'idle' : state.status });
  }

  function select(id) {
    if (disposed) return false;
    const preference = id === null ? null : state.catalog.inputs.find(input => input.id === id);
    if (preference === undefined) return false;
    let storageFailed = false;
    try {
      const storage = getStorage();
      if (preference) storage.setItem(MICROPHONE_PREFERENCE_KEY, JSON.stringify(preference));
      else storage.removeItem(MICROPHONE_PREFERENCE_KEY);
    } catch { storageFailed = true; }
    publish({ preference, storageFailed, revealError: '' });
    return true;
  }

  return {
    canReveal,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot: () => state,
    loadPreference, refresh, reveal, cancelReveal, select,
    dispose() {
      disposed = true;
      listeners.clear();
      probe?.abort.abort();
      probe = null;
    },
  };
}


function applyMicrophoneCopy(dicts) {
  Object.assign(dicts.en, {
    'mic.choose': 'Choose microphone',
    'mic.current': 'Microphone: {name}',
    'mic.system': 'System default',
    'mic.systemNamed': 'System default · {name}',
    'mic.reveal': 'Show microphone names',
    'mic.revealing': 'Waiting for microphone access…',
    'mic.namesHint': 'Permission may be needed to display device names. This does not start dictation.',
    'mic.namesUnavailable': 'The browser did not provide any named microphones.',
    'mic.listLoading': 'Looking for microphones…',
    'mic.retryList': 'Refresh list',
    'mic.notListed': '{name} is not in the list. Reconnect it or choose another microphone.',
    'mic.storageFailed': 'Could not save the choice. It will apply until the page is closed or reloaded.',
    'error.micSelectedMissing': 'The selected microphone is unavailable. Reconnect it or use the arrow next to the microphone to choose another one.',
    'error.micPinUnsupported': 'This browser cannot open a specific microphone. Choose System default to use the browser’s microphone.',
    'error.micPinMismatch': 'The browser returned a different microphone. Recording did not start.',
    'error.micBusy': 'Could not open the microphone. It may be in use by another app.',
    'error.micOpen': 'Could not open the microphone. Check its connection and permissions.',
    'error.micList': 'Could not load the microphone list.',
  });
  Object.assign(dicts.ru, {
    'mic.choose': 'Выбрать микрофон',
    'mic.current': 'Микрофон: {name}',
    'mic.system': 'Системный по умолчанию',
    'mic.systemNamed': 'По умолчанию · {name}',
    'mic.reveal': 'Показать названия микрофонов',
    'mic.revealing': 'Ожидание доступа к микрофону…',
    'mic.namesHint': 'Для отображения названий может понадобиться разрешение. Диктовка при этом не начнётся.',
    'mic.namesUnavailable': 'Браузер не показал ни одного микрофона с названием.',
    'mic.listLoading': 'Ищу микрофоны…',
    'mic.retryList': 'Обновить список',
    'mic.notListed': 'Микрофона «{name}» нет в списке. Подключите его снова или выберите другой.',
    'mic.storageFailed': 'Не удалось сохранить выбор. Он действует до закрытия или обновления страницы.',
    'error.micSelectedMissing': 'Выбранный микрофон недоступен. Подключите его снова или выберите другой через стрелку рядом с микрофоном.',
    'error.micPinUnsupported': 'Браузер не позволяет открыть конкретный микрофон. Выберите «Системный по умолчанию», чтобы записывать с микрофона браузера.',
    'error.micPinMismatch': 'Браузер открыл не тот микрофон. Запись не началась.',
    'error.micBusy': 'Не удалось открыть микрофон. Возможно, его использует другое приложение.',
    'error.micOpen': 'Не удалось открыть микрофон. Проверьте его подключение и разрешения.',
    'error.micList': 'Не удалось загрузить список микрофонов.',
  });
  Object.assign(dicts.zh, {
    'mic.choose': '选择麦克风',
    'mic.current': '麦克风：{name}',
    'mic.system': '系统默认',
    'mic.systemNamed': '系统默认 · {name}',
    'mic.reveal': '显示麦克风名称',
    'mic.revealing': '正在等待麦克风权限…',
    'mic.namesHint': '显示设备名称可能需要授权。授权不会开始听写。',
    'mic.namesUnavailable': '浏览器未提供任何有名称的麦克风。',
    'mic.listLoading': '正在查找麦克风…',
    'mic.retryList': '刷新列表',
    'mic.notListed': '列表中没有「{name}」。请重新连接或选择其他麦克风。',
    'mic.storageFailed': '无法保存选择。它将在关闭或刷新页面前生效。',
    'error.micSelectedMissing': '所选麦克风不可用。请重新连接，或用麦克风旁的箭头选择其他设备。',
    'error.micPinUnsupported': '此浏览器无法打开指定的麦克风。请选择「系统默认」。',
    'error.micPinMismatch': '浏览器打开了其他麦克风。录音未开始。',
    'error.micBusy': '无法打开麦克风，可能正被其他应用使用。',
    'error.micOpen': '无法打开麦克风。请检查连接和权限。',
    'error.micList': '无法加载麦克风列表。',
  });
}

function microphoneLabels({ catalog, preference }, t) {
  const system = catalog.defaultLabel ? t('mic.systemNamed', { name: catalog.defaultLabel }) : t('mic.system');
  const selected = catalog.inputs.find(input => input.id === preference?.id);
  return { system, current: selected?.label ?? preference?.label ?? system, listed: Boolean(selected) };
}

function validCssZoom(value) {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function microphoneMenuPlacement(rect, { left = 0, top = 0, width, height }, contentZoom = 1) {
  const zoom = validCssZoom(contentZoom);
  const marginX = Math.min(8, width / 8);
  const marginY = Math.min(8, height / 8);
  const minX = left + marginX;
  const maxX = left + width - marginX;
  const minY = top + marginY;
  const maxY = top + height - marginY;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const gap = 6 * zoom;
  const menuWidth = Math.min(330 * zoom, maxX - minX);
  const x = clamp(rect.right - menuWidth, minX, maxX - menuWidth);
  const upperEdge = clamp(rect.top - gap, minY, maxY);
  const lowerEdge = clamp(rect.bottom + gap, minY, maxY);
  const above = upperEdge - minY;
  const below = maxY - lowerEdge;
  const visibleHeight = maxY - minY;
  // On a keyboard-shortened screen an anchored strip may be too short to use.
  // Fall back to a scrollable panel inside the viewport, even if it overlaps the trigger.
  const anchored = Math.max(above, below) >= Math.min(96 * zoom, visibleHeight);
  const opensUp = anchored && (above >= 180 * zoom || above > below);
  const y = !anchored ? minY : opensUp ? upperEdge : lowerEdge;
  const room = !anchored ? visibleHeight : opensUp ? above : below;
  // The body portal cancels UI Zoom on its positioning box. DOMRect, viewport
  // bounds and fixed left/top/size therefore all use viewport CSS pixels.
  return {
    left: x,
    top: y,
    width: menuWidth,
    maxHeight: Math.min(360 * zoom, room),
    transform: opensUp ? 'translateY(-100%)' : undefined,
  };
}

function microphoneVisualViewport() {
  const vv = window.visualViewport;
  return vv && vv.width > 0 && vv.height > 0
    ? { left: vv.offsetLeft, top: vv.offsetTop, width: vv.width, height: vv.height }
    : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
}

function microphoneUiZoom() {
  // UI Zoom publishes the factor and its inverse in the same :root style commit.
  return validCssZoom(Number(window.getComputedStyle(document.documentElement).getPropertyValue('--dsh-ui-zoom-factor')));
}

let lastMicrophoneMenuLayout = null;

function measureMicrophoneMenu(menu) {
  const box = menu.getBoundingClientRect();
  const { left, top, width, height } = microphoneVisualViewport();
  const tolerance = 1; // Allow subpixel rounding of the border box.
  const roundZoom = value => Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
  return {
    fitsViewport: box.width > 0 && box.height > 0 && box.left >= left - tolerance && box.top >= top - tolerance
      && box.right <= left + width + tolerance && box.bottom <= top + height + tolerance,
    uiZoomPercent: Math.round(microphoneUiZoom() * 1000) / 10,
    positioningZoom: roundZoom(menu.currentCSSZoom),
    contentZoom: roundZoom(menu.firstElementChild?.currentCSSZoom),
  };
}

function microphoneMenuLayoutStatus() {
  const menu = document.body.querySelector('.dsh-lp-device-menu');
  return { open: menu ? measureMicrophoneMenu(menu) : null, last: lastMicrophoneMenuLayout };
}

function createMicrophonePicker(React, ReactDOM, onMount) {
  const h = React.createElement;
  const { useEffect, useId, useLayoutEffect, useRef, useState } = React;
  function position(trigger) {
    return microphoneMenuPlacement(trigger.getBoundingClientRect(), microphoneVisualViewport(), microphoneUiZoom());
  }

  return function MicrophonePicker({ model, snapshot, labels, t, disabled }) {
    const id = useId();
    const trigger = useRef(null);
    const panel = useRef(null);
    const owner = useRef(Symbol('microphone picker'));
    const [placement, setPlacement] = useState(null);
    const expanded = Boolean(placement) && !disabled;
    const close = (restoreFocus = false) => {
      model.cancelReveal(owner.current);
      setPlacement(null);
      if (restoreFocus) trigger.current?.focus({ preventScroll: true });
    };

    useEffect(onMount, []);
    useEffect(() => { if (disabled) setPlacement(null); }, [disabled]);
    useLayoutEffect(() => {
      if (!expanded) return;
      const ownerKey = owner.current;
      const onOutside = event => {
        if (panel.current?.contains(event.target) || trigger.current?.contains(event.target)) return;
        model.cancelReveal(ownerKey);
        setPlacement(null);
      };
      const update = () => {
        const anchor = trigger.current;
        if (!anchor?.isConnected) return;
        const next = position(anchor);
        setPlacement(previous => previous && Object.keys(next).some(key => next[key] !== previous[key]) ? next : previous);
      };
      panel.current?.focus({ preventScroll: true });
      window.addEventListener('pointerdown', onOutside, true);
      window.addEventListener('focusin', onOutside, true);
      window.addEventListener('resize', update);
      window.addEventListener('scroll', update, true);
      const viewport = window.visualViewport;
      viewport?.addEventListener('resize', update);
      viewport?.addEventListener('scroll', update);
      // Changing document CSS zoom can reflow the root without a window resize.
      const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
      observer?.observe(document.documentElement);
      if (trigger.current) observer?.observe(trigger.current);
      return () => {
        observer?.disconnect();
        window.removeEventListener('pointerdown', onOutside, true);
        window.removeEventListener('focusin', onOutside, true);
        window.removeEventListener('resize', update);
        window.removeEventListener('scroll', update, true);
        viewport?.removeEventListener('resize', update);
        viewport?.removeEventListener('scroll', update);
        model.cancelReveal(ownerKey);
      };
    }, [expanded, model]);
    useLayoutEffect(() => {
      if (expanded && panel.current) lastMicrophoneMenuLayout = measureMicrophoneMenu(panel.current);
    }, [expanded, placement, snapshot]);

    const { catalog, preference, status, revealing, revealError, storageFailed } = snapshot;
    const mayNeedPermission = status === 'ready' && (catalog.hidden || !catalog.inputs.length);
    const select = (value) => {
      if (model.select(value) && !model.getSnapshot().storageFailed) close(true);
    };
    const option = (value, name) => {
      const selected = value === (preference?.id ?? null);
      return h('button', { key: value ?? 'system', type: 'button', className: 'dsh-lp-device-option',
        'aria-pressed': selected, disabled: revealing, onClick: () => select(value),
      }, h('span', { className: 'dsh-lp-device-check', 'aria-hidden': true }, selected ? '✓' : ''), name);
    };
    const caption = `${t('mic.choose')} · ${t('mic.current', { name: labels.current })}`;
    return h(React.Fragment, null,
      h('button', {
        type: 'button', ref: trigger, disabled, className: 'dsh-lp-mic dsh-lp-device-trigger',
        'aria-label': caption, 'aria-haspopup': 'dialog', 'aria-expanded': expanded,
        'aria-controls': expanded ? id : undefined, title: caption,
        onClick: () => {
          if (expanded) { close(true); return; }
          setPlacement(position(trigger.current));
          void model.refresh();
        },
        onKeyDown: event => {
          if (event.key === 'Escape' && expanded) { event.preventDefault(); event.stopPropagation(); close(true); }
        },
      }, h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('path', { d: 'm4 6 4 4 4-4', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }))),
      expanded ? ReactDOM.createPortal(h('div', {
        id, ref: panel, role: 'dialog', 'aria-labelledby': `${id}-title`, tabIndex: -1,
        className: 'dsh-lp-device-menu', style: placement,
        onKeyDown: event => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close(true);
          } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            const buttons = [...panel.current.querySelectorAll('button:not(:disabled)')];
            if (!buttons.length) return;
            const index = buttons.indexOf(document.activeElement);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
              : event.key === 'ArrowDown' ? (index + 1) % buttons.length : index < 1 ? buttons.length - 1 : index - 1;
            event.preventDefault();
            event.stopPropagation();
            buttons[next].focus();
          }
        },
      },
      h('div', { className: 'dsh-lp-device-content' },
       h('div', { id: `${id}-title`, className: 'dsh-lp-device-title' }, t('mic.choose')),
      h('div', { className: 'dsh-lp-device-options' }, option(null, labels.system), ...catalog.inputs.map(input => option(input.id, input.label))),
      preference && !labels.listed
        ? h('p', { className: 'dsh-lp-device-info', role: 'status' }, t(status === 'ready' && !catalog.hidden ? 'mic.notListed' : 'mic.current', { name: preference.label })) : null,
      status === 'loading' && !revealing ? h('p', { className: 'dsh-lp-device-info', role: 'status' }, t('mic.listLoading')) : null,
      status === 'error' || status === 'unsupported' ? h('p', { className: 'dsh-lp-device-info', role: 'status' }, t(status === 'error' ? 'error.micList' : 'error.micUnsupported')) : null,
      revealError ? h('p', { className: 'dsh-lp-device-info', role: 'alert' }, t(revealError)) : null,
      storageFailed ? h('p', { className: 'dsh-lp-device-info', role: 'status' }, t('mic.storageFailed')) : null,
      mayNeedPermission && !revealing ? h('p', { className: 'dsh-lp-device-info' }, t('mic.namesHint')) : null,
      model.canReveal && (revealing || mayNeedPermission || status === 'error')
        ? h('button', { type: 'button', className: 'dsh-lp-button dsh-lp-device-action', 'aria-disabled': revealing,
          onClick: async event => {
            if (revealing) return;
            const revealButton = event.currentTarget;
            await model.reveal(owner.current);
            const active = document.activeElement;
            if (panel.current && (active === revealButton || active === document.body) && model.getSnapshot().catalog.inputs.length) {
              panel.current.querySelector('.dsh-lp-device-option[aria-pressed="true"], .dsh-lp-device-option')?.focus({ preventScroll: true });
            }
          },
        }, t(revealing ? 'mic.revealing' : 'mic.reveal')) : null,
      status === 'error' && !revealing
        ? h('button', { type: 'button', className: 'dsh-lp-button dsh-lp-device-action', onClick: () => { void model.refresh(); } }, t('mic.retryList')) : null,
      )), document.body) : null,
    );
  };
}


// One cap shared by the DSH Host's WAV validation and the browser recorder.
const RIG_MAX_RECORDING_SECONDS = 240;
// Polaris uses fixed 20s windows for interactive jobs (preview and final).
const RIG_WINDOW_SECONDS = 20;

function createRecordingBudget(sampleRate, advertisedSeconds) {
  const configured = Number(advertisedSeconds);
  const seconds = configured > 0 ? Math.min(configured, RIG_MAX_RECORDING_SECONDS) : 120;
  const maxSamples = Math.floor(sampleRate * seconds);
  let count = 0;
  return {
    seconds,
    take(samples) {
      const remaining = maxSamples - count;
      const accepted = samples.length > remaining ? samples.subarray(0, remaining) : samples;
      count += accepted.length;
      return accepted;
    },
    full: () => count >= maxSamples,
  };
}

function recordingLimitLabel(seconds) {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}


// Pure browser coordination. This module is inlined with the recorder; no DOM
// dependency and no direct calls to Polaris from the browser.
function createPreviewBarrier() {
  let active;
  let closed = false;
  return {
    pending: () => active !== undefined,
    start(send) {
      if (closed || active) throw new Error('Preview is not admissible');
      const job = Promise.resolve().then(send);
      active = job;
      const clear = () => { if (active === job) active = undefined; };
      void job.then(clear, clear);
      return job;
    },
    async close() {
      closed = true;
      // A preview failure is never a final failure. On normal stop, wait for
      // the last request; do not abort a healthy inference to free the worker.
      await active?.catch(() => {});
    },
  };
}

function isNativeEmpty(error) {
  return error?.status === 502 && error.code === 'native_empty';
}

// These replies describe a terminal job, not a failed upload or a network
// timeout. An explicit retry must not replay the same stored error forever.
const terminalAsrCodes = new Set([
  'native_empty', 'native_http', 'native_protocol', 'native_incomplete', 'native_transport',
  'interrupted', 'worker_unavailable', 'processing_failed', 'result_erased', 'delivery_full', 'cancelled',
]);

async function splitFinalWav(wav, windowSeconds) {
  const header = await wav.slice(0, 44).arrayBuffer();
  const view = new DataView(header);
  const rate = view.getUint32(24, true);
  const bytes = view.getUint32(40, true);
  // Input is the recorder's own canonical mono PCM16 WAV (not an arbitrary
  // file). Mirror Polaris's fixed windows; do not run a browser VAD or trim.
  if (rate < 8000 || rate > 16000 || !bytes || bytes % 2 || bytes + 44 !== wav.size ||
      !Number.isSafeInteger(windowSeconds) || windowSeconds < 1) throw new Error('Invalid final WAV');
  const stride = rate * 2 * windowSeconds;
  if (bytes <= stride) return [wav];
  const windows = [];
  for (let offset = 0; offset < bytes; offset += stride) {
    const size = Math.min(stride, bytes - offset);
    const segmentHeader = header.slice(0);
    const segmentView = new DataView(segmentHeader);
    // The Host requires a minimum 512 bytes. Preserve even a sub-frame tail
    // from the last audio callback; fill only the missing bytes with zeroes.
    const padded = Math.max(512 - 44, size);
    segmentView.setUint32(4, 36 + padded, true);
    segmentView.setUint32(40, padded, true);
    windows.push(new Blob([segmentHeader, wav.slice(44 + offset, 44 + offset + size), new Uint8Array(padded - size)], { type: 'audio/wav' }));
  }
  return windows;
}

function createFinalTranscription(wav, { send, signal, windowSeconds }) {
  let windows;
  let index = 0;
  let attempt = 0;
  let uncertain = false;
  const transcripts = [];
  const check = () => signal?.throwIfAborted();
  const run = async (body, segment = null) => {
    check();
    try {
      const result = await send(body, { segment, attempt });
      check();
      return String(result?.text ?? '').trim();
    } catch (error) {
      if (terminalAsrCodes.has(error?.code)) attempt += 1;
      throw error;
    }
  };
  return {
    async finish() {
      if (!windows) {
        try {
          return { text: await run(wav), recovered: false, uncertain: false };
        } catch (error) {
          if (!isNativeEmpty(error)) throw error;
          const candidates = await splitFinalWav(wav, windowSeconds);
          if (candidates.length === 1) throw error;
          check();
          windows = candidates;
          attempt = 0;
        }
      }
      // The whole result cannot be delivered if one window produces no text.
      // Re-decode the same PCM in order, retaining each successful delivery in
      // the browser. An unrelated error must not be treated as a quiet window.
      while (index < windows.length) {
        try {
          const text = await run(windows[index], index);
          if (text) transcripts.push(text);
        } catch (error) {
          if (isNativeEmpty(error) || (error?.status === 422 && error.code === 'empty')) uncertain = true;
          else throw error;
        }
        index += 1;
        attempt = 0;
      }
      return { text: transcripts.join(' '), recovered: true, uncertain };
    },
  };
}


    const MicrophonePicker = createMicrophonePicker(React, ReactDOM, () => {
      diagnostics.microphonePickers += 1;
      return () => { diagnostics.microphonePickers -= 1; };
    });

    function releaseStartup(token) {
      if (!token) return;
      const stream = token.stream;
      token.stream = null;
      for (const track of stream?.getTracks() ?? []) {
        try { track.stop(); } catch { /* Already stopped. */ }
      }
      const context = token.context;
      token.context = null;
      try { context?.close().catch(() => {}); } catch { /* Already closed. */ }
    }

    function ownsDraft(rec, resolveInput) {
      if (rec.conflict || resolveInput(rec.sessionId) !== rec.input) return false;
      const current = rec.input.state.getSnapshot();
      if (current.draftRev !== rec.ownedRevision || current.draft !== rec.ownedDraft ||
          !['plain', 'claimed'].includes(current.phase)) {
        rec.conflict = true;
        return false;
      }
      return true;
    }

    function writeOwnedDraft(rec, resolveInput, inputActions, text) {
      if (!ownsDraft(rec, resolveInput)) return false;
      inputActions.setDraft(text);
      const next = rec.input.state.getSnapshot();
      rec.ownedRevision = next.draftRev;
      rec.ownedDraft = next.draft;
      return next.draft === text;
    }

    function MicButton(props) {
      const { inputActions, sessionId, locale, onActiveChange, resolveInput, sendLabels, canRecord, microphone } = props;
      const { levels, clips } = useLevels(sessionId);
      const state = useStore();
      const t = useT(locale);
      const microphoneSnapshot = useSyncExternalStore(microphone.subscribe, microphone.getSnapshot);
      const micLabels = microphoneLabels(microphoneSnapshot, t);
      const [prepareOpen, setPrepareOpen] = useState(false);
      const [limitFlash, setLimitFlash] = useState(false);
      const limitFlashTimer = useRef(0);
      const recRef = useRef(null);
      const recordingGenerationRef = useRef(0);
      const stopRef = useRef(null);
      const startRef = useRef(null);
      const cancelRef = useRef(null);
      const prepareOpenRef = useRef(false);
      const finishingRef = useRef(null);
      const failedFinalRef = useRef(null);
      const reviewRef = useRef(null);
      const reviewBlockedRef = useRef(false);
      const activityRef = useRef(null);
      const startingRef = useRef(null);
      const submitGateRef = useRef(false);
      const clearTimerRef = useRef(0);
      const mountedRef = useRef(true);
      const tRef = useRef(t);
      tRef.current = t;
      const activeChangeRef = useRef(onActiveChange);
      activeChangeRef.current = onActiveChange;
      prepareOpenRef.current = prepareOpen;

      const clearStatusSoon = useCallback((id, delay) => {
        window.clearTimeout(clearTimerRef.current);
        const status = store.state;
        clearTimerRef.current = window.setTimeout(() => {
          if (store.state === status && store.state.sessionId === id) {
            publish({ phase: 'idle', message: '', elapsed: 0, sessionId: null });
          }
        }, delay);
      }, []);

      useEffect(() => {
        mountedRef.current = true;
        return () => {
          mountedRef.current = false;
          recordingGenerationRef.current += 1;
          failedFinalRef.current?.requests.abort();
          failedFinalRef.current = null;
          releaseStartup(startingRef.current);
          startingRef.current = null;
          window.clearTimeout(clearTimerRef.current);
          window.clearTimeout(limitFlashTimer.current);
          const rec = recRef.current;
          recRef.current = null;
          if (!rec) return;
          rec.active = false;
          rec.requests.abort();
          window.clearInterval(rec.streamTimer);
          publishLevels(rec.sessionId, EMPTY_LEVELS, EMPTY_CLIPS);
          window.clearInterval(rec.timer);
          try {
            rec.processor.onaudioprocess = null;
            rec.source.disconnect();
            rec.processor.disconnect();
            rec.gain.disconnect();
          } catch {
            // Already disconnected.
          }
          for (const track of rec.stream.getTracks()) {
            try {
              track.stop();
            } catch {
              // Already stopped.
            }
          }
          rec.context.close().catch(() => {});
        };
      }, []);

      const fail = useCallback(
        (id, message, limitSeconds = null, allowRetry = true) => {
          if (!mountedRef.current) return;
          const take = failedFinalRef.current;
          const canRetryFinal = allowRetry && take?.sessionId === id && take.duration >= 0.35 && take.chunks.length > 0;
          if (limitSeconds != null) diagnostics.lastRecordingLimit = { seconds: limitSeconds, outcome: canRetryFinal ? 'retry-available' : 'failed' };
          publish({ phase: 'error', message, elapsed: 0, sessionId: id, limitSeconds, canRetryFinal });
          if (failedFinalRef.current) window.clearTimeout(clearTimerRef.current);
          else clearStatusSoon(id, 10000);
        },
        [clearStatusSoon],
      );

      useEffect(() => {
        let off;
        try {
          const input = resolveInput(sessionId);
          if (!input) throw new Error('Session input unavailable');
          off = interceptSubmit(input, {
            needsFinish: () => Boolean(recRef.current || finishingRef.current || startingRef.current || failedFinalRef.current),
            finish: () => stopRef.current?.(),
            isCurrent: () => mountedRef.current && resolveInput(sessionId) === input && !props.locked && (!canRecord || canRecord(sessionId)) && (props.targetKind === 'question' || ![...voiceControls.values()].some(control => control.questionSession === sessionId)),
            onError: () => {
              if (!mountedRef.current || resolveInput(sessionId) !== input) return;
              fail(sessionId, tRef.current('error.insert'));
              input.notify('error', tRef.current('status.notSent'));
            },
            onBlocked: () => {
              if (store.state.sessionId !== sessionId || !store.state.uncertainFinal) input.notify('error', tRef.current('status.notSent'));
            },
          });
          submitGateRef.current = true;
        } catch {
          submitGateRef.current = false;
        }
        return () => { submitGateRef.current = false; off?.(); };
      }, [resolveInput, sessionId, inputActions, fail, canRecord, props.locked]);

      const streamPartial = useCallback(async () => {
        const rec = recRef.current;
        if (!rec || !rec.active || !rec.streaming) return;
        const stream = rec.streamState;
        if (rec.previewRequest.pending() || stream.pendingChunks.length === 0 || !stream.hasSpeech) return;
        const chunkCount = stream.pendingChunks.length;
        const speechVersion = stream.speechVersion;
        const samples = mergeChunks(stream.pendingChunks);
        if (samples.length < stream.sampleRate * 0.8) return;
        const finalize = stream.silenceMs >= STREAM_PAUSE_MS || samples.length >= stream.sampleRate * stream.maxSeconds;
        // No new speech: keep the provisional text without repeatedly decoding
        // the same phrase, until the longer pause actually closes the window.
        if (!finalize && stream.decodedSpeechVersion === speechVersion) return;
        try {
          const wav = encodeWav(samples, stream.sampleRate);
          const result = await rec.previewRequest.start(() => api('/transcribe', {
            method: 'POST',
            headers: {
              'content-type': 'audio/wav',
              'x-dictation-language': navigator.language || 'ru-RU',
              ...captureHeaders(rec, 'preview'),
            },
            body: wav,
            signal: rec.requests.signal,
          }));
          if (!rec.active) return;
          const text = String(result?.text ?? '').trim();
          if (finalize) {
            if (text.length > 0) stream.finalizedText = joinText(stream.finalizedText, text);
            // Only consume the snapshot sent to the worker. Audio callbacks keep
            // running during inference, and their suffix belongs to the next window.
            stream.pendingChunks.splice(0, chunkCount);
            stream.partialText = '';
            if (stream.speechVersion === speechVersion) {
              // No speech arrived during inference: the suffix is just silence.
              stream.pendingChunks = [];
              stream.silenceMs = 0;
              stream.hasSpeech = false;
            }
          } else {
            // A provisional end-of-utterance dot should not look committed while
            // the speaker is still thinking. Stop re-decodes the audio with normal
            // punctuation; internal sentence boundaries, ? and ! stay untouched.
            stream.partialText = text;
          }
          stream.decodedSpeechVersion = speechVersion;
          try {
            const previewText = stream.partialText.replace(/(?<!\.)\.$/u, '');
            writeOwnedDraft(rec, resolveInput, inputActions, composeStreamDraft(rec.baseDraft, stream.finalizedText, previewText));
          } catch {
            // The final stop path inserts the complete transcript.
          }
        } catch {
          // Keep the pending audio; the stop path decodes it again.
        }
      }, [inputActions, resolveInput]);

      const finishRecording = useCallback(async () => {
        const rec = recRef.current || failedFinalRef.current;
        if (!rec) {
          if (startingRef.current) {
            releaseStartup(startingRef.current);
            startingRef.current = null;
            if (store.state.sessionId === sessionId) publish({ phase: 'idle', message: '', elapsed: 0, sessionId: null });
            return true;
          }
          return false;
        }
        const firstStop = recRef.current === rec;
        const limitSeconds = rec.limitSeconds ?? null;
        if (firstStop) {
          rec.active = false;
          activeChangeRef.current?.(false);
          window.clearInterval(rec.streamTimer);
          window.clearInterval(rec.timer);
          recRef.current = null;
          publishLevels(rec.sessionId, EMPTY_LEVELS, EMPTY_CLIPS);
          try {
            rec.processor.onaudioprocess = null;
            rec.source.disconnect(); rec.processor.disconnect(); rec.gain.disconnect();
          } catch { /* Already disconnected. */ }
          for (const track of rec.stream.getTracks()) {
            try { track.stop(); } catch { /* Already stopped. */ }
          }
          rec.duration = limitSeconds ?? (performance.now() - rec.startedAt) / 1000;
        }
        // Retain the frozen raw recording until a successful final decode or an
        // explicit discard. A second Send after an error must not send a preview.
        failedFinalRef.current = rec;
        publish({ phase: 'processing', message: '', elapsed: rec.duration, sessionId: rec.sessionId, limitSeconds });
        const previewSettled = rec.previewRequest.close();
        if (firstStop) { try { await rec.context.close(); } catch { /* Already closed. */ } }
        await previewSettled;
        const isCurrent = () => mountedRef.current && !rec.requests.signal.aborted && rec.generation === recordingGenerationRef.current && resolveInput(rec.sessionId) === rec.input;
        if (!isCurrent()) return false;
        if (rec.duration < 0.35 || rec.chunks.length === 0) {
          fail(rec.sessionId, tRef.current('error.tooShort'), limitSeconds);
          return false;
        }
        try {
          if (!rec.finalDecode) {
            // The final pass always tries ALL captured PCM, including quiet and
            // sub-200ms suffixes. Do not promote preview text to a final result.
            const wav = encodeWav(mergeChunks(rec.chunks), rec.context.sampleRate);
            rec.finalDecode = createFinalTranscription(wav, {
              signal: rec.requests.signal, windowSeconds: RIG_WINDOW_SECONDS,
              send: (body, key) => api('/transcribe', {
                method: 'POST',
                headers: { 'content-type': 'audio/wav', 'x-dictation-language': navigator.language || 'ru-RU', ...captureHeaders(rec, 'final', key) },
                body, signal: rec.requests.signal,
              }),
            });
          }
          const result = await rec.finalDecode.finish();
          if (!isCurrent()) return false;
          const { text: transcript, uncertain: uncertainFinal } = result;
          if (!transcript) { fail(rec.sessionId, tRef.current('error.empty'), limitSeconds, false); return false; }
          let inserted = false;
          try {
            inserted = rec.streaming
              ? writeOwnedDraft(rec, resolveInput, inputActions, composeStreamDraft(rec.baseDraft, '', transcript))
              : ownsDraft(rec, resolveInput) && insertTranscript(transcript, rec.insertion, inputActions, rec.insertionDraft);
          } catch { /* Preserve the final transcript for explicit insertion. */ }
          failedFinalRef.current = null;
          if (!inserted) {
            if (limitSeconds != null) diagnostics.lastRecordingLimit = { seconds: limitSeconds, outcome: 'ready-to-insert' };
            publish({ phase: 'pending', message: transcript, elapsed: rec.duration, sessionId: rec.sessionId, limitSeconds, uncertainFinal });
            return false;
          }
          if (limitSeconds != null) diagnostics.lastRecordingLimit = { seconds: limitSeconds, outcome: 'draft' };
          publish(rec.streaming && limitSeconds == null && !uncertainFinal
            ? { phase: 'idle', message: '', elapsed: 0, sessionId: null }
            : { phase: 'done', message: transcript, elapsed: rec.duration, sessionId: rec.sessionId, limitSeconds, uncertainFinal });
          if (limitSeconds == null && !uncertainFinal) clearStatusSoon(rec.sessionId, 4000);
          return !uncertainFinal; // Keep recovered text, but do not send without review.
        } catch (error) {
          if (!isCurrent()) return false;
          const empty = error.code === 'empty' || (error.status === 502 && error.code === 'native_empty');
          const busy = ['upload_busy', 'queue_full', 'work_full', 'delivery_full', 'worker_unavailable', 'resource_wait', 'draining'].includes(error.code);
          const code = empty ? 'error.empty' : rec.backend === 'rig'
            ? busy ? 'error.rigBusyFinal' : 'error.rigFinal'
            : friendlyError(error);
          fail(rec.sessionId, code.includes('.') ? tRef.current(code) : code, limitSeconds);
          return false;
        }
      }, [clearStatusSoon, fail, inputActions, resolveInput]);

      const stop = useCallback(() => {
        if (finishingRef.current) return finishingRef.current;
        const result = finishRecording();
        finishingRef.current = result;
        const clear = () => { if (finishingRef.current === result) finishingRef.current = null; };
        void result.then(clear, clear);
        return result;
      }, [finishRecording]);

      const cancel = useCallback(async () => {
        const cancelledGeneration = ++recordingGenerationRef.current;
        reviewRef.current?.cancel('cancelled');
        releaseStartup(startingRef.current);
        startingRef.current = null;
        failedFinalRef.current?.requests.abort();
        failedFinalRef.current = null;
        const rec = recRef.current;
        if (!rec) {
          if (store.state.sessionId === sessionId) publish({ phase: 'idle', message: '', elapsed: 0, sessionId: null });
          return;
        }
        rec.active = false;
        rec.requests.abort();
        activeChangeRef.current?.(false);
        window.clearInterval(rec.streamTimer);
        recRef.current = null;
        publishLevels(rec.sessionId, EMPTY_LEVELS, EMPTY_CLIPS);
        window.clearInterval(rec.timer);

        try {
          rec.processor.onaudioprocess = null;
          rec.source.disconnect();
          rec.processor.disconnect();
          rec.gain.disconnect();
        } catch {
          // Already disconnected.
        }
        for (const track of rec.stream.getTracks()) {
          try {
            track.stop();
          } catch {
            // Already stopped.
          }
        }
        try {
          await rec.context.close();
        } catch {
          // Closing an already closed context is harmless.
        }

        if (!mountedRef.current || cancelledGeneration !== recordingGenerationRef.current || resolveInput(rec.sessionId) !== rec.input) return;
        if (rec.streaming) {
          try {
            writeOwnedDraft(rec, resolveInput, inputActions, rec.baseDraft);
          } catch {
            // Never replace user edits with an old pre-recording draft.
          }
        }
        if (store.state.sessionId === sessionId) publish({ phase: 'idle', message: '', elapsed: 0, sessionId: null });
      }, [inputActions, resolveInput, sessionId]);

      stopRef.current = stop;
      cancelRef.current = cancel;

      const start = useCallback(async () => {
        if (recRef.current || finishingRef.current || startingRef.current) return;
        if (!mountedRef.current || props.locked || (canRecord && !canRecord(sessionId))) return;
        const choice = microphone.getSnapshot();
        if (choice.revealing) return;
        // Freeze the device at admission, including for hold-to-talk and question answers.
        const preferredInput = choice.preference;
        const activeElsewhere = ({ sessionId: id, phase }) => id && id !== sessionId && ['starting', 'recording', 'processing'].includes(phase);
        const other = store.state;
        const previous = activeElsewhere(other) && voiceControls.get(other.sessionId);
        if (activeElsewhere(other) && !previous?.cancel) return;
        if (!submitGateRef.current) {
          fail(sessionId, tRef.current('error.submitUnsupported'));
          return;
        }
        const input = resolveInput(sessionId);
        if (!input || !['plain', 'claimed'].includes(input.state.getSnapshot().phase)) return;
        failedFinalRef.current = null; // A new recording explicitly replaces any failed raw take.
        reviewRef.current?.cancel('new-recording');
        // A hold must own startup immediately, even while a previous composer is closing.
        const token = { generation: ++recordingGenerationRef.current };
        startingRef.current = token;
        window.clearTimeout(clearTimerRef.current);
        const isCurrent = () => mountedRef.current && startingRef.current === token && resolveInput(sessionId) === input;
        try {
          if (previous) {
            await previous.cancel();
            if (!isCurrent() || props.locked || (canRecord && !canRecord(sessionId)) || activeElsewhere(store.state)) return;
          }
          publish({ phase: 'starting', message: '', elapsed: 0, sessionId });

          let status;
          try {
            status = await api('/status');
          } catch {
            if (isCurrent()) fail(sessionId, tRef.current('error.network'));
            return;
          }
          if (!isCurrent()) return;

          if (!status?.ready) {
            publish({ phase: 'idle', message: '', elapsed: 0, sessionId: null });
            setPrepareOpen(true);
            return;
          }

          let capture;
          try {
            capture = await openMicrophone(navigator.mediaDevices, preferredInput);
            token.stream = capture.stream;
          } catch (error) {
            if (isCurrent()) {
              const key = error?.message;
              fail(sessionId, key?.startsWith('error.mic') ? tRef.current(key) : tRef.current('error.micOpen'));
              void microphone.refresh();
            }
            return;
          }
          if (!isCurrent()) return;
          const { stream, label: microphoneLabel } = capture;
          void microphone.refresh();

          const AudioContextClass = window.AudioContext || window.webkitAudioContext;
          if (!AudioContextClass) {
            fail(sessionId, tRef.current('error.micUnsupported'));
            return;
          }

          const context = new AudioContextClass();
          token.context = context;
          await context.resume();
          if (!isCurrent()) return;

          const snapshot = input.state.getSnapshot();
          const source = context.createMediaStreamSource(stream);
          const processor = context.createScriptProcessor(4096, 1, 1);
          const gain = context.createGain();
          gain.gain.value = 0;
          source.connect(processor);
          processor.connect(gain);
          gain.connect(context.destination);
          const insertion = captureInsertion(inputActions);
          const insertionDraft = snapshot.draft;
          const streaming =
            typeof inputActions?.setDraft === 'function' &&
            (snapshot.occurrences?.length ?? 0) === 0 &&
            insertion !== undefined &&
            insertion.start === insertion.end &&
            insertion.start === snapshot.draft.length;
          const baseDraft = snapshot.draft;
          const budget = createRecordingBudget(context.sampleRate, status.maxRecordingSeconds);
          const finishAtLimit = () => {
            const rec = recRef.current;
            if (!rec?.active || rec.generation !== token.generation || rec.limitSeconds != null) return;
            rec.limitSeconds = budget.seconds;
            diagnostics.lastRecordingLimit = { seconds: budget.seconds, outcome: 'processing' };
            window.clearTimeout(limitFlashTimer.current);
            setLimitFlash(true);
            limitFlashTimer.current = window.setTimeout(() => setLimitFlash(false), 700);
            // This is finalization, not the drag-cancel path. Do not arm auto-send.
            void stopRef.current?.();
          };
          const chunks = [];
          const levels = [];
          const clips = [];
          const streamState = {
            pendingChunks: [],
            silenceMs: 0,
            sampleRate: context.sampleRate,
            maxSeconds: Number(status.maxSegmentSeconds) > 0 ? Number(status.maxSegmentSeconds) : 20,
            hasSpeech: false,
            speechVersion: 0,
            decodedSpeechVersion: -1,
            finalizedText: '',
            partialText: '',
          };
          processor.onaudioprocess = (event) => {
            if (!recRef.current?.active || recRef.current.generation !== token.generation) return;
            const input = budget.take(event.inputBuffer.getChannelData(0));
            if (!input.length) return;
            chunks.push(new Float32Array(input));
            let sum = 0;
            let peak = 0;
            for (let index = 0; index < input.length; index += 1) {
              const value = input[index];
              sum += value * value;
              const magnitude = Math.abs(value);
              if (magnitude > peak) peak = magnitude;
            }
            const rms = Math.sqrt(sum / input.length);
            levels.push(Math.max(0, Math.min(1, rms / 0.16)));
            clips.push(peak >= 0.92 || rms >= 0.3);
            if (levels.length > 96) {
              levels.shift();
              clips.shift();
            }
            publishLevels(sessionId, levels.slice(), clips.slice());
            if (streaming) {
              if (rms >= SPEECH_RMS) {
                streamState.hasSpeech = true;
                streamState.speechVersion += 1;
                streamState.pendingChunks.push(new Float32Array(input));
                streamState.silenceMs = 0;
              } else if (streamState.hasSpeech) {
                streamState.pendingChunks.push(new Float32Array(input));
                streamState.silenceMs += (input.length / streamState.sampleRate) * 1000;
              }
            }
            if (budget.full()) finishAtLimit();
          };

          const startedAt = performance.now();
          const timer = window.setInterval(() => {
            if (recRef.current?.generation !== token.generation) return;
            const elapsed = (performance.now() - startedAt) / 1000;
            if (elapsed >= budget.seconds) {
              finishAtLimit();
              return;
            }
            publish({ phase: 'recording', message: '', elapsed, sessionId });
          }, 250);

          recRef.current = {
            stream,
            microphoneLabel,
            context,
            source,
            processor,
            gain,
            chunks,
            startedAt,
            timer,
            insertion,
            insertionDraft,
            sessionId,
            streaming,
            baseDraft,
            input,
            generation: token.generation,
            takeId: window.crypto.randomUUID(),
            backend: status.backend,
            requestSequence: 0,
            previewRequest: createPreviewBarrier(),
            requests: new AbortController(),
            ownedDraft: snapshot.draft,
            ownedRevision: snapshot.draftRev,
            conflict: false,
            streamState,
            streamTimer: 0,
            active: true,
          };
          // The active recording now owns these resources; startup cancellation
          // owns only resources still awaiting permission/audio-context readiness.
          token.stream = null;
          token.context = null;
          if (streaming) {
            recRef.current.streamTimer = window.setInterval(() => {
              void streamPartial();
            }, 900);
          }

          publishLevels(sessionId, EMPTY_LEVELS, EMPTY_CLIPS);
          publish({ phase: 'recording', message: '', elapsed: 0, sessionId });
          activeChangeRef.current?.(true);
        } catch {
          if (isCurrent()) fail(sessionId, tRef.current('error.generic'));
        } finally {
          releaseStartup(token);
          if (startingRef.current === token) startingRef.current = null;
        }
      }, [fail, inputActions, sessionId, resolveInput, streamPartial, canRecord, props.locked, microphone]);

      startRef.current = start;

      useEffect(() => {
        const control = {
          start: () => startRef.current?.(), stop: () => stopRef.current?.(), cancel: () => cancelRef.current?.(),
          discard: () => {
            recordingGenerationRef.current += 1;
            reviewBlockedRef.current = true;
            failedFinalRef.current?.requests.abort();
            failedFinalRef.current = null;
            reviewRef.current?.cancel('cancelled');
          },
        };
        voiceControls.set(sessionId, control);
        return () => { if (voiceControls.get(sessionId) === control) voiceControls.delete(sessionId); };
      }, [sessionId]);

      useEffect(() => {
        if (!sendLabels) return; // Question answers NEVER inherit automatic message sending.
        const input = resolveInput(sessionId);
        if (!input || input.targetKind === 'question') return;
        const current = () => mountedRef.current && resolveInput(sessionId) === input && !props.locked && (!canRecord || canRecord(sessionId)) &&
          ![...voiceControls.values()].some(control => control.questionSession === sessionId) &&
          Boolean(activityRef.current?.isConnected) && document.visibilityState !== 'hidden';
        // The explicit pointer gesture authorizes capture even if mobile focus is
        // stale. Automatic sending still requires a focused foreground page.
        const autoCurrent = () => current() && (typeof document.hasFocus !== 'function' || document.hasFocus());
        const focused = () => {
          const card = activityRef.current?.closest('[data-composer-card]');
          const element = document.activeElement;
          return card?.contains(element) && element?.matches?.('textarea,input,[contenteditable="true"],[role="textbox"]');
        };
        const review = createReviewCountdown({
          read: () => input.state.getSnapshot(), current: autoCurrent,
          submit: (...args) => input.submit(...args),
          publish: (next) => {
            if (!mountedRef.current) return;
            if (next.active) publish({ phase: 'review', sessionId, message: '', remaining: next.remaining });
            else if (store.state.phase === 'review' && store.state.sessionId === sessionId) publish({ phase: 'idle', sessionId: null, message: '' });
          },
          setInterval: window.setInterval.bind(window), clearInterval: window.clearInterval.bind(window),
        });
        reviewRef.current = review;
        const off = bindNativeHold({
          root: () => activityRef.current, input, labels: sendLabels,
          allowed: () => canBeginHold({ current: current(), guardReady: submitGateRef.current, locked: Boolean(props.locked),
            recording: Boolean(recRef.current), starting: Boolean(startingRef.current), finishing: Boolean(finishingRef.current),
            phase: input.state.getSnapshot().phase }),
          unavailable: () => input.notify('info', tRef.current('hold.unavailable')),
          start: () => { reviewBlockedRef.current = false; review.cancel('new-recording'); return startRef.current?.(); },
          stop: () => stopRef.current?.(), cancel: () => cancelRef.current?.(),
          hasCapture: () => Boolean(recRef.current?.chunks.length),
          captureOwner: () => recRef.current?.generation ?? startingRef.current?.generation,
          reviewed: (args) => {
            if (reviewBlockedRef.current || !current()) return;
            window.clearTimeout(clearTimerRef.current);
            review.arm(args);
          },
          focus: () => { reviewBlockedRef.current = true; review.cancel('focused'); },
          changed: () => review.check(), trace: result => { diagnostics.lastTouchHold = result; }, document, window,
        });
        return () => { off(); review.dispose(); if (reviewRef.current === review) reviewRef.current = null; };
      }, [sendLabels, resolveInput, sessionId, inputActions, canRecord, props.locked]);

      const recording = state.phase === 'recording' && state.sessionId === sessionId;
      const busy = (state.phase === 'processing' || state.phase === 'starting') && state.sessionId === sessionId;
      const pending = state.phase === 'pending' && state.sessionId === sessionId;
      const actionLabel = recording ? t('mic.stop') : pending ? t('mic.pending') : busy ? t('mic.processing') : (props.micLabel || t('mic.start'));
      const title = `${actionLabel} · ${t('mic.current', { name: (recording && recRef.current?.microphoneLabel) || micLabels.current })}`;

      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.defaultPrevented || event.isComposing || event.target?.closest?.('.dsh-lp-device-menu') || (canRecord && !canRecord(sessionId))) return;
          if (props.targetKind !== 'question' && [...voiceControls.values()].some(control => control.questionSession === sessionId)) return;
          const current = store.state;
          const isRecording = current.phase === 'recording' && current.sessionId === sessionId;
          const isBusy = current.phase === 'processing' || current.phase === 'starting';
          const ctrlSpace =
            event.ctrlKey &&
            !event.altKey &&
            !event.metaKey &&
            (event.code === 'Space' || event.key === ' ');

          if (ctrlSpace) {
            if (event.repeat || prepareOpenRef.current) return;
            event.preventDefault();
            event.stopPropagation();
            if (isRecording) {
              void stopRef.current?.();
            } else if (!isBusy && current.phase !== 'pending') {
              void startRef.current?.();
            }
            return;
          }

          if (event.key === 'Escape' && isRecording) {
            if (event.repeat) return;
            event.preventDefault();
            event.stopPropagation();
            void cancelRef.current?.();
            return;
          }

          // Let the native keymap resolve Enter, queue/steer, slash menus and
          // modifiers. The SessionInput.submit gate finalizes before admission.
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
      }, [inputActions, sessionId, props.targetKind, canRecord]);

      useEffect(() => {
        activeChangeRef.current?.(recording);
        return () => activeChangeRef.current?.(false);
      }, [recording]);

      return h(
        React.Fragment,
        null,
        h('style', { key: 'style' }, STYLE),
        h(
          'div',
          {
            key: 'activity',
            ref: activityRef,
            'data-dsh-lp-hold': sendLabels ? '' : undefined,
            className: `dsh-lp-activity${recording ? ' dsh-lp-activity-rec' : ''}`,
          },
          recording ? h(Waveform, { key: 'wave', levels, clips }) : null,
          h(
            'button',
            {
              key: 'button',
              type: 'button',
              className: `dsh-lp-mic${recording ? ' dsh-lp-mic-rec' : ''}`,
              title,
              'aria-label': title,
              'aria-pressed': recording ? 'true' : 'false',
              'aria-busy': busy ? 'true' : 'false',
              disabled: busy || pending || (!recording && (props.locked || microphoneSnapshot.revealing)),
              onPointerDown: event => { if (event.button === 0) event.preventDefault(); },
              onMouseDown: event => { if (event.button === 0) event.preventDefault(); },
              onClick: () => {
                if (recording) void stop();
                else void start();
              },
            },
            recording ? h(StopIcon) : busy ? h(Spinner) : h(MicIcon),
          ),
          recording ? null : h(MicrophonePicker, {
            key: sessionId, model: microphone, snapshot: microphoneSnapshot, labels: micLabels, t,
            disabled: busy || Boolean(props.locked),
          }),
        ),
        limitFlash ? ReactDOM.createPortal(h('div', { className: 'dsh-lp-limit-flash', 'aria-hidden': true }), document.body) : null,
        prepareOpen
          ? h(PrepareDialog, {
              key: 'prepare',
              t,
              onClose: () => setPrepareOpen(false),
              onReady: () => {
                setPrepareOpen(false);
                void start();
              },
            })
          : null,
      );
    }

    function StatusRow(props) {
      const { sessionId, locale, inputActions, useInput } = props;
      const draft = useInput((state) => state.draft);
      const state = useStore();
      const t = useT(locale);

      if (!state.sessionId || state.sessionId !== sessionId) return null;
      if (state.phase === 'idle' || state.phase === 'starting' || state.phase === 'recording') return null;

      const isError = state.phase === 'error';
      const isDone = state.phase === 'done';
      const isPending = state.phase === 'pending';
      const isReview = state.phase === 'review';
      const isRecording = state.phase === 'recording';
      const limitReached = state.limitSeconds != null;
      const time = limitReached ? recordingLimitLabel(state.limitSeconds) : '';
      const warning = state.uncertainFinal ? t('status.finalUncertain') : '';
      const text = limitReached ? t(isDone ? 'status.limitDone' : isPending ? 'status.limitPending' : isError ? 'status.limitFailed' : 'status.limitProcessing',
        { time, text: preview(state.message), error: state.message })
        : isReview ? t('status.autoSend', { seconds: state.remaining }) : isError
        ? state.message
        : isRecording
          ? t('status.recording', { seconds: Math.floor(state.elapsed) })
          : isDone
            ? t('status.done', { text: preview(state.message) })
            : isPending
              ? t('status.pending', { text: preview(state.message) })
              : t('status.processing');

      const insertPending = () => {
        if (!isPending) return;
        if (insertTranscript(state.message, captureInsertion(inputActions), inputActions, draft)) {
          if (limitReached) diagnostics.lastRecordingLimit = { seconds: state.limitSeconds, outcome: 'draft' };
          publish({ phase: 'done', message: state.message, elapsed: 0, sessionId: state.sessionId, limitSeconds: state.limitSeconds, uncertainFinal: state.uncertainFinal });
        }
      };

      return h(
        React.Fragment,
        null,
        h('style', { key: 'style' }, STYLE),
        h(
          'div',
          {
            key: 'status',
            className: `dsh-lp-status${isRecording ? ' dsh-lp-status-rec' : ''}${isError ? ' dsh-lp-status-err' : ''}${isDone ? ' dsh-lp-status-ok' : ''}${isPending ? ' dsh-lp-status-pending' : ''}${limitReached ? ' dsh-lp-status-limit' : ''}${warning ? ' dsh-lp-status-uncertain' : ''}`,
            role: isError ? 'alert' : 'status',
            'aria-live': isError ? 'assertive' : 'polite',
          },
          h('span', { className: `dsh-lp-dot${isRecording ? ' dsh-lp-dot-rec' : ''}`, 'aria-hidden': true }),
          h('span', { className: 'dsh-lp-status-text' }, warning ? `${text} ${warning}` : text),
          isPending
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-lp-insert',
                  onClick: insertPending,
                },
                t('status.insert'),
              )
            : null,
          isReview ? h('button', {
            type: 'button', className: 'dsh-lp-insert',
            onClick: () => voiceControls.get(sessionId)?.discard(),
          }, t('status.cancelAutoSend')) : null,
          isError && state.canRetryFinal ? h('button', {
            type: 'button', className: 'dsh-lp-insert',
            onMouseDown: event => { if (event.button === 0) event.preventDefault(); },
            onPointerDown: event => { if (event.button === 0) event.preventDefault(); },
            onClick: () => { void voiceControls.get(sessionId)?.stop(); },
          }, t('status.retryFinal')) : null,
          isError || isPending || ((limitReached || warning) && isDone)
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-lp-dismiss',
                  title: t(state.canRetryFinal ? 'status.discardTake' : 'status.dismiss'),
                  'aria-label': t(state.canRetryFinal ? 'status.discardTake' : 'status.dismiss'),
                  onClick: () => { voiceControls.get(sessionId)?.discard(); publish({ phase: 'idle', message: '', elapsed: 0, sessionId: null }); },
                },
                '×',
              )
            : null,
        ),
      );
    }

    function PrepareDialog(props) {
      const { t, onClose, onReady } = props;
      const [status, setStatus] = useState(null);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const primaryRef = useRef(null);
      const pollTimer = useRef(0);
      const tRef = useRef(t);
      tRef.current = t;

      const refresh = useCallback(async () => {
        try {
          const next = await api('/status');
          setStatus(next);
          if (next?.error) setError(next.error);
          else if (next?.ready) setError('');
          return next;
        } catch (failure) {
          setError(failure?.message || tRef.current('error.network'));
          return null;
        }
      }, []);

      useEffect(() => {
        let cancelled = false;
        const tick = async () => {
          if (cancelled) return;
          const next = await refresh();
          if (cancelled) return;
          if (!next?.ready) {
            pollTimer.current = window.setTimeout(tick, 1500);
          }
        };
        void tick();
        const focusTimer = window.setTimeout(() => primaryRef.current?.focus(), 50);
        return () => {
          cancelled = true;
          window.clearTimeout(pollTimer.current);
          window.clearTimeout(focusTimer);
        };
      }, [refresh]);

      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
      }, [onClose]);

      const prepare = async () => {
        setBusy(true);
        setError('');
        try {
          await api('/prepare', { method: 'POST' });
          await refresh();
        } catch (failure) {
          setError(failure?.message || tRef.current('prepare.error'));
        } finally {
          setBusy(false);
        }
      };

      const ready = status?.ready === true;
      const failed = status?.phase === 'error';
      const preparing = busy || status?.preparing === true;
      const size = Number(status?.estimatedModelMb);
      const phase = status?.phase;

      let message;
      if (ready) message = t('prepare.ready');
      else if (failed) message = status?.error || t('prepare.error');
      else if (preparing) {
        message = phase === 'installing'
          ? t('prepare.phase.installing')
          : phase === 'downloading'
            ? t('prepare.phase.downloading', { model: status?.model || '' })
            : t('prepare.preparing');
      } else {
        message = status ? t('error.notPrepared') : t('prepare.phase.checking');
      }

      const dialog = h(
        'div',
        {
          className: 'dsh-lp-backdrop',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) onClose();
          },
        },
        h(
          'div',
          {
            className: 'dsh-lp-dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'dsh-lp-prepare-title',
          },
          h('style', null, STYLE),
          h('h2', { id: 'dsh-lp-prepare-title' }, status?.backend === 'local' ? 'Local Parakeet · CPU6 · explicit rollback' : t('prepare.title')),
          h('p', null, status?.backend === 'local' ? 'Explicit local rollback selected. Existing shared Windows CPU worker; no Rig inference.' : t('prepare.description')),
          h(
            'div',
            { className: 'dsh-lp-model' },
            h('span', null, t('prepare.model', { model: status?.model || 'qwen3-asr-1.7b' })),
            Number.isFinite(size) && size > 0
              ? h('span', { className: 'dsh-lp-hint' }, t('prepare.size', { size }))
              : h('span', { className: 'dsh-lp-hint' }, t('prepare.sizeUnknown')),
          ),
          h(
            'div',
            {
              className: `dsh-lp-prepare-status${ready ? ' dsh-lp-status-ok' : failed ? ' dsh-lp-status-err' : ''}`,
              role: 'status',
              'aria-live': 'polite',
            },
            ready || failed ? h('span', { className: 'dsh-lp-dot' }) : h(Spinner),
            h('span', null, message),
          ),
          error ? h('div', { className: 'dsh-lp-error', role: 'alert' }, error) : null,
          h('div', { className: 'dsh-lp-hint' }, status?.backend === 'local' ? 'Explicit local rollback uses the existing installed Windows worker.' : t('prepare.hint')),
          h(
            'div',
            { className: 'dsh-lp-actions' },
            h(
              'button',
              { type: 'button', className: 'dsh-lp-button', onClick: onClose },
              t('prepare.close'),
            ),
            ready
              ? h(
                  'button',
                  {
                    ref: primaryRef,
                    type: 'button',
                    className: 'dsh-lp-button dsh-lp-button-primary',
                    onClick: onReady,
                  },
                  t('prepare.readyAction'),
                )
              : h(
                  'button',
                  {
                    ref: primaryRef,
                    type: 'button',
                    className: 'dsh-lp-button dsh-lp-button-primary',
                    onClick: () => void prepare(),
                    disabled: preparing,
                  },
                  preparing ? t('prepare.preparing') : failed ? t('prepare.retry') : t('prepare.start'),
                ),
          ),
        ),
      );

      return ReactDOM.createPortal(dialog, document.body);
    }
    return {
      inject: ['slots', 'locale', 'sessions', 'conversation'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICTS));
        ctx.effect(() => ctx.locale.register('local-parakeet.question', qvCopy));
        const media = navigator.mediaDevices;
        const microphone = createMicrophoneSelection(media, () => window.localStorage);
        ctx.effect(() => {
          const onStorage = (event) => {
            if (event.key === MICROPHONE_PREFERENCE_KEY || event.key === null) microphone.loadPreference();
          };
          media?.addEventListener?.('devicechange', microphone.refresh);
          window.addEventListener('storage', onStorage);
          void microphone.refresh();
          return () => {
            media?.removeEventListener?.('devicechange', microphone.refresh);
            window.removeEventListener('storage', onStorage);
            microphone.dispose();
          };
        }, 'local-parakeet: microphone selection');
        const VoiceMic = (props) => h(MicButton, { ...props, microphone });
        const resolveInput = (sessionId) => {
          const binding = ctx.sessions.binding(sessionId);
          return binding ? ctx.conversation.input.for(binding.ctx) : undefined;
        };
        const uiSession = ctx.get('uiSession');
        const canRecord = (sessionId) => Boolean(uiSession) && uiSession.sessionStatus.getSnapshot().get(sessionId)?.pendingInteraction === undefined;
        ctx.effect(() => {
          let pending = new Set();
          const update = () => {
            const next = new Set([...uiSession.sessionStatus.getSnapshot()].filter(([, status]) => status.pendingInteraction !== undefined).map(([id]) => id));
            for (const id of next) if (!pending.has(id)) void voiceControls.get(id)?.cancel?.();
            pending = next;
          };
          if (!uiSession) return;
          update();
          return uiSession.sessionStatus.subscribe(update);
        }, 'local-parakeet: composer ownership');
        const sendLabels = () => {
          const t = ctx.locale.bind('conversation');
          return ['input.send', 'input.send.queue', 'input.send.steer', 'input.continue', 'input.stop'].map(key => t(key));
        };
        const RigSettings = createRigSettings(React, { api });
        ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'rig-asr', order: 65, label: 'Rig ASR' }, RigSettings));
        const questionVoice = createQuestionVoice(React, { MicButton: VoiceMic, StatusRow, locale: ctx.locale, controls: voiceControls });
        ctx.slots.inject('conversation.composer', () => ctx.slots.register({
          name: 'conversation.composer', priority: -1, select: questionVoice.select,
        }, questionVoice.Component));
        ctx.inject(['cordisInspect'], (scope) => {
          scope.effect(() => scope.get('cordisInspect').register({
            manifest: {
              id: 'LocalParakeet',
              description: 'Read-only voice capture and submit-guard readiness; no audio or draft text.',
              methods: [{
                name: 'status', description: 'Read this page’s voice plugin version and readiness without opening a microphone.',
                inputSchema: { type: 'object', properties: { touchOnly: { type: 'boolean' } }, additionalProperties: false },
                outputSchema: { type: 'object', description: 'Version, control readiness, menu fit, and last touch hold or recording-limit outcome. No device identifiers, draft text, or coordinates.' },
              }],
            },
            async query(method, input) {
              if (method !== 'status') throw new Error('Unknown method');
              const touch = navigator.maxTouchPoints > 0;
              if (input?.touchOnly && !touch) throw new Error('not-touch-page');
              const microphoneMenuLayout = microphoneMenuLayoutStatus();
              return {
                version: '1.2.6', origin: window.location.origin, touch,
                secureContext: window.isSecureContext === true,
                microphoneApi: typeof media?.getUserMedia === 'function',
                microphoneListApi: typeof media?.enumerateDevices === 'function',
                microphonePickers: diagnostics.microphonePickers,
                microphoneMenuFitsViewport: microphoneMenuLayout.open?.fitsViewport ?? null,
                microphoneMenuLayout,
                audioContextApi: Boolean(window.AudioContext || window.webkitAudioContext),
                phase: store.state.phase, submitGuards: diagnostics.guards,
                questionVoice: true, holdToTalk: true, autoSendSeconds: 30, pendingInteractionGuard: Boolean(uiSession),
                touchHoldSlopPercent: TOUCH_HOLD_SLOP_FRACTION * 100,
                lastTouchHold: diagnostics.lastTouchHold,
                rigMaxRecordingSeconds: RIG_MAX_RECORDING_SECONDS,
                lastRecordingLimit: diagnostics.lastRecordingLimit,
              };
            },
          }), 'local-parakeet: read-only readiness');
        });

        ctx.slots.inject('conversation.input.activity', () =>
          ctx.slots.register(
            { name: 'conversation.input.activity' },
            (props) => h(VoiceMic, { ...props, locale: ctx.locale, resolveInput, sendLabels, canRecord }),
          ),
        );

        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.dock',
              id: 'local-parakeet-status',
              order: 30,
            },
            (props) => h(StatusRow, { ...props, locale: ctx.locale }),
          ),
        );
      },
    };
  },
});
