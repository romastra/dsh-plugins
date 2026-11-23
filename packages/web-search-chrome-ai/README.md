# Chrome AI Mode search

Бандл регистрирует поисковый провайдер `local-chrome` для DSH. Он использует [agent-browser](https://github.com/vercel-labs/agent-browser) и Google AI Mode: в результат попадают текст ответа и источники, которые показал Google. Это адаптация [tabsp/dsh-web-search-chrome 0.1.1](https://github.com/tabsp/dsh-web-search-chrome) по MIT; см. [лицензию upstream](LICENSE.upstream).

Установите agent-browser отдельно. Проверьте путь к его исполняемому файлу (на Windows задайте абсолютный путь к нативному EXE, если он не в PATH). Используйте отдельный профиль Chrome без переноса cookies/паролей; при необходимости войдите в Google самостоятельно. После проверки включите строку `web-search-chrome-ai` и выберите `local-chrome` как поисковый провайдер DSH. Bundle не переопределяет штатные пресеты: настройте `tool-web.searchTimeoutMs` в используемом пресете, если его тайм-аут меньше 180 с.

Поисковые запросы отправляются в Google. В опубликованной версии нет аккаунта, локального профиля Chrome или сетевого прокси.
