# Пример стороннего агента

Пакет содержит только декларативный `manifest.json` и не исполняет JavaScript в процессе 2AOS.

```bash
node bin/2aos.mjs pack examples/declarative-agent process-summary.zip
```

Затем отправьте ZIP в `POST /v1/packages/upload`, дождитесь модерации и создайте installation quote. Для production-реестра подпишите manifest перед упаковкой:

```bash
node bin/2aos.mjs sign registry-private-key.pem examples/declarative-agent/manifest.json
```

Публичный SPKI-ключ реестра передаётся серверу в `A2OS_REGISTRY_PUBLIC_KEY` как base64 DER. Не публикуйте приватный ключ в пакете или репозитории.
