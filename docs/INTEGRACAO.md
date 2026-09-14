# Guia de Integração — para os alunos

Este é o backend que o app de e-commerce do **seu grupo** vai consumir.
Vocês **não** rodam este servidor: ele já está no ar. Vocês só **consomem a API**.

---

## 1. O que vocês receberam do professor

- **URL base** da API — ex.: `https://ecommerce-turma.onrender.com`
- **API Key do grupo** — ex.: `sk_live_xxxxxxxxxxxx`

⚠️ **A API Key identifica o grupo e isola os dados de vocês.** Não compartilhem com
outros grupos e **não commitem a chave** em repositório público — guardem em variável
de ambiente do app de vocês.

---

## 2. As duas identificações em toda chamada

Toda requisição à API leva **sempre** estes dois headers:

```
X-API-Key: sk_live_xxxxxxxxxxxx      ← a chave do grupo (obrigatória)
X-Student-RM: RM550001               ← o RM de quem está mexendo (rastreio)
```

> O `X-Student-RM` é como o professor sabe **quem** do grupo fez cada parte.
> Coloquem o RM de quem está codando/testando. Isso conta na avaliação.

Além desses, quando o **cliente final** (o comprador da loja de vocês) faz login,
as chamadas dele também levam:

```
Authorization: Bearer <token-recebido-no-login>
```

---

## 3. Documentação interativa (Swagger)

Abram no navegador:

```
<URL-BASE>/docs
```

Lá dá para ver **todos os endpoints, os campos de cada um e testar na hora**
(cliquem em "Authorize" para colar a API Key e o RM).

---

## 4. Fluxo típico de uma compra

```
1. Listar produtos            GET  /products
2. Cadastrar/logar cliente    POST /auth/register  ou  /auth/login   → recebe token
3. Adicionar ao carrinho      POST /cart/items       (com o token)
4. Fechar o pedido            POST /orders/checkout  (vira um pedido PENDING)
5. Pagar                      POST /orders/:id/pay   (aprova → PAID, baixa estoque)
```

---

## 5. Exemplos com `fetch` (JavaScript/TypeScript)

```ts
const BASE = 'https://SUA-URL-BASE';
const headers = {
  'X-API-Key': 'sk_live_xxxxxxxxxxxx',
  'X-Student-RM': 'RM550001',
  'Content-Type': 'application/json',
};

// 1. Listar produtos e pegar o DETALHE (que traz as variantes)
const produtos = await fetch(`${BASE}/products`, { headers }).then((r) => r.json());
const produto = await fetch(`${BASE}/products/${produtos.data[0].id}`, { headers }).then((r) => r.json());
const variante = produto.variants[0]; // a unidade vendável é a VARIANTE

// 2. Cadastrar um cliente final e guardar o token
const { token } = await fetch(`${BASE}/auth/register`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ name: 'Maria', email: 'maria@x.com', password: '123456' }),
}).then((r) => r.json());

// 3. Adicionar ao carrinho por VARIANTE (agora com o token do cliente)
const auth = { ...headers, Authorization: `Bearer ${token}` };
await fetch(`${BASE}/cart/items`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ variantId: variante.id, quantity: 2 }),
});

// 4. Checkout
const pedido = await fetch(`${BASE}/orders/checkout`, { method: 'POST', headers: auth })
  .then((r) => r.json());

// 5. Pagar (PIX)
await fetch(`${BASE}/orders/${pedido.id}/pay`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ method: 'PIX' }),
});
```

---

## 6. SDK pronto (opcional, recomendado)

Em vez de escrever `fetch` toda hora, copiem o arquivo
[`sdk/ecommerce-client.ts`](../sdk/ecommerce-client.ts) para o projeto de vocês:

```ts
import { EcommerceClient } from './ecommerce-client';

const api = new EcommerceClient({
  baseUrl: 'https://SUA-URL-BASE',
  apiKey: 'sk_live_xxxxxxxxxxxx',
  studentRm: 'RM550001',
});

const { data: produtos } = await api.products.list({ search: 'fone' });
const prod = await api.products.get(produtos[0].id);   // detalhe com variantes
await api.auth.login({ email: 'maria@x.com', password: '123456' }); // guarda o token sozinho
await api.cart.addItem(prod.variants[0].id, 1);        // adiciona por VARIANTE
const pedido = await api.orders.checkout();
await api.orders.pay(pedido.id, { method: 'CREDIT_CARD' });
```

> O SDK guarda o token do cliente automaticamente depois do `login()`/`register()`.

---

## 7. Enviar fotos e vídeos dos produtos

O arquivo vai para a API em `multipart/form-data`; ela guarda no **Amazon S3** e
devolve a **URL pública**. Essa URL é a que vocês usam no `<Image />` do app —
ela não expira.

**Jeito curto: sobe e já vincula ao produto.**

```ts
// React Native (expo-image-picker)
const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'] });
const foto = { uri: r.assets[0].uri, name: 'foto.jpg', type: 'image/jpeg' };

const form = new FormData();
form.append('file', foto as any);
form.append('isPrimary', 'true');       // vira a capa do produto

const res = await fetch(`${BASE}/products/${produtoId}/media`, {
  method: 'POST',
  headers: { 'X-API-Key': API_KEY },    // NÃO coloque Content-Type aqui!
  body: form,
});
const { url } = await res.json();
```

> ⚠️ **Nunca** defina `Content-Type` na mão num upload. O `fetch` precisa gerar o
> `boundary` sozinho; se vocês fixarem o header, o upload quebra. Esse é o erro
> mais comum.

**Jeito longo: biblioteca de mídia.** Útil para reaproveitar a mesma foto em
vários produtos ou para montar uma galeria no painel.

```ts
// 1) sobe para a biblioteca da loja
const media = await api.media.upload(foto, { folder: 'produtos' });
// → { id, url, kind: 'IMAGE', mimeType, sizeBytes }

// 2) vincula onde quiser (quantas vezes quiser)
await api.products.addImage(produtoId, { mediaId: media.id, isPrimary: true });
await api.products.addImage(outroProdutoId, { mediaId: media.id });
```

**Vídeo é igual**: mesmo endpoint, mesmo campo `file`. Na resposta do produto,
imagem e vídeo vêm separados:

```ts
const prod = await api.products.get(produtoId);
prod.images;  // só imagens — use no carrossel
prod.videos;  // só vídeos  — use num player
```

**O que a API recusa (e por quê):**

| Situação | Resposta |
|---|---|
| Arquivo que não é imagem/vídeo | `415` — o tipo é conferido pelos bytes, então renomear `.pdf` para `.jpg` não engana |
| Arquivo acima do limite | `413` com o limite em MB na mensagem |
| Loja sem espaço | `422` — veja quanto sobrou em `GET /media/usage` |
| Apagar mídia em uso | `409` — use `DELETE /media/:id?force=true` se quiser apagar mesmo assim |

Formatos aceitos: **JPEG, PNG, WebP, GIF, AVIF, MP4, WebM e MOV**.

Para liberar espaço:

```ts
const { usedBytes, quotaBytes } = await api.media.usage();
await api.media.remove(media.id);        // some do bucket também
```

## 8. Pagamento e frete (sandbox — simulados)

Há **dois jeitos** de pagar:

**a) Atalho síncrono** (paga e confirma na hora — qualquer método):

```jsonc
POST /orders/:id/pay   { "method": "PIX" }                              // aprova (padrão)
POST /orders/:id/pay   { "method": "CREDIT_CARD", "simulate": "decline" } // força recusa
```

**b) Gateway realista** (como um PSP de verdade: cria cobrança → confirma → webhook):

```jsonc
// 1. cria a cobrança ligada ao pedido (PIX volta copia-e-cola; boleto, linha digitável)
POST /sandbox/payments   { "method": "PIX", "orderId": "<id>" }         // status PENDING
// 2. confirma (no mundo real, o banco faria isso) → paga o pedido + dispara webhook
POST /sandbox/payments/:id/settle   { "simulate": "approve" }
```

Cartão é sempre síncrono (aprova/recusa na hora, aceita `installments`). Recusa **não**
baixa estoque.

**Frete fake** — cotação por CEP e rastreamento:

```jsonc
POST /sandbox/shipping/quote   { "cepDestino": "90000000", "orderId": "<id>" }
// → PAC / SEDEX / TRANSPORTADORA / RETIRADA_LOJA com preço e prazo
POST /sandbox/shipments        { "orderId": "<id>", "service": "SEDEX", "cepDestino": "90000000" }
POST /sandbox/shipments/:id/advance   // avança postado→trânsito→entregue (dispara shipment.updated)
```

> Tudo em `/sandbox/*` é **FAKE** (rotulado no Swagger). Nenhum dado real de cartão é aceito.

---

## 9. Como os erros chegam

Sempre neste formato:

```json
{ "error": { "code": "UNPROCESSABLE", "message": "Estoque insuficiente. Disponível: 3." } }
```

Principais status: `400` dados inválidos · `401` chave/token faltando ou inválido ·
`404` não encontrado · `409` conflito (ex.: e-mail já cadastrado) · `422` regra de
negócio (ex.: estoque, carrinho vazio).

---

## 10. Gerar um SDK na linguagem de vocês (avançado)

O spec OpenAPI está em `<URL-BASE>/docs/json`. Com ele dá para gerar um client em
qualquer linguagem usando o [openapi-generator](https://openapi-generator.tech/):

```bash
npx @openapitools/openapi-generator-cli generate \
  -i https://SUA-URL-BASE/docs/json \
  -g typescript-fetch \
  -o ./api-gerada
```

Troquem `-g` por `java`, `dart`, `csharp`, `python` etc. conforme o app de vocês.

---

## 11. Webhooks (receber eventos em tempo real)

Em vez de ficar consultando a API, vocês podem **receber eventos** (ex.: `order.paid`,
`product.low_stock`) automaticamente. Registrem uma URL pública do app de vocês:

```ts
const wh = await api.webhooks.create({
  url: 'https://SEU-APP.exemplo.com/webhooks/ecommerce',   // precisa ser HTTPS
  events: ['order.paid', 'product.low_stock'],             // ou ['*'] para todos
});
console.log(wh.signingSecret); // GUARDE — mostrado só uma vez!
```

O backend faz `POST` na URL com o evento e estes headers:

```
X-Signature: sha256=<hmac>     X-Timestamp: <ms>     X-Webhook-Event: order.paid
```

Corpo: `{ "id", "type", "createdAt", "data": { ... } }`.

### Verificar a assinatura (OBRIGATÓRIO — prova que veio do backend)

Recalculem o HMAC-SHA256 de `` `${timestamp}.${body}` `` com o `signingSecret` e comparem
com o header. Exemplo em Node:

```ts
import crypto from 'node:crypto';

function verificar(secret: string, req): boolean {
  const ts = req.headers['x-timestamp'];
  const assinatura = req.headers['x-signature'];
  const body = req.rawBody; // o corpo CRU (string), não o JSON já parseado
  const esperado = 'sha256=' + crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(assinatura), Buffer.from(esperado));
}
```

> A entrega é **at-least-once**: o mesmo evento pode chegar mais de uma vez (ex.: se vocês
> demorarem a responder). **Sejam idempotentes** — usem o `id` do evento para não processar
> duas vezes. Respondam **2xx rápido**; senão o backend tenta de novo (retry com backoff) e,
> após várias falhas, marca como *dead-letter*.

Dá para depurar tudo: `api.webhooks.deliveries()` mostra o histórico de entregas (status,
tentativas, resposta), `api.webhooks.ping(id)` envia um evento de teste, e
`api.webhooks.resend(deliveryId)` reenvia.
