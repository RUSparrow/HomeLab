<!-- OPENWIKI:START -->

## OpenWiki

See [AGENTS.md](AGENTS.md) for OpenWiki agent instructions.

## Граф проекта (graphify)

Перед широким поиском по репозиторию сначала смотри граф, а не читай файлы подряд: это экономит токены.
- `graphify-out/GRAPH_REPORT.md`: хабы, сообщества, связи.
- `graphify query "<вопрос>"`, `graphify explain "<узел>"`, `graphify path "A" "B"`, `graphify affected "<узел>"`: точечные ответы по `graphify-out/graph.json`.

После изменений кода пересобери граф (только AST, без LLM) и обнови страницу на :8083:
`graphify update . --force && cp graphify-out/graph.html graph.html`. `graph.html` и `graphify-out/` в git не хранятся.

<!-- OPENWIKI:END -->
