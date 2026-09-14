/**
 * SDK cliente do E-commerce API — Projeto da Turma
 * ------------------------------------------------
 * Client TypeScript, sem dependências (usa fetch nativo).
 * Copie este arquivo para o app do grupo, ou publiquem como pacote.
 *
 * Conceito-chave: a UNIDADE VENDÁVEL é a VARIANTE.
 *   - Produto SIMPLE tem 1 variante (default).
 *   - Produto VARIABLE tem N variantes (ex.: Cor x Tamanho).
 *   - Carrinho/pedido operam sobre `variantId`.
 *
 * Uso rápido:
 *   const api = new EcommerceClient({ baseUrl, apiKey, studentRm: 'RM550001' });
 *   const { data } = await api.products.list({ search: 'camiseta' });
 *   const prod = await api.products.get(data[0].id);       // detalhe com variantes
 *   await api.auth.login({ email, password });
 *   await api.cart.addItem(prod.variants[0].id, 1);        // adiciona por VARIANTE
 *   const pedido = await api.orders.checkout();
 *   await api.orders.pay(pedido.id, { method: 'PIX' });
 */

export interface EcommerceClientOptions {
  baseUrl: string;
  apiKey: string;
  /** RM do aluno que está usando (enviado em X-Student-RM para rastreio). */
  studentRm?: string;
  customerToken?: string;
}

export type ProductType = 'SIMPLE' | 'VARIABLE';
export type ProductState = 'DRAFT' | 'PUBLISHED' | 'HIDDEN';

export interface ProductVariant {
  id: string;
  sku: string;
  barcode: string | null;
  price: number;
  stock: number;
  minStock: number;
  isDefault: boolean;
  active: boolean;
  label: string | null; // ex.: "Preto / P"
  options: { option: string; value: string }[];
  images: ProductImage[];
  /** Vídeos (mesma estrutura das imagens, kind = 'VIDEO'). */
  videos: ProductImage[];
}

export interface ProductImage {
  id: string;
  url: string;
  /** IMAGE ou VIDEO — a mesma lista guarda os dois. */
  kind: MediaKind;
  /** Id na biblioteca de mídia quando veio de um upload; null se a URL é externa. */
  mediaId: string | null;
  position: number;
  isPrimary: boolean;
}

export type MediaKind = 'IMAGE' | 'VIDEO';

/** Avaliação de um produto feita por um cliente que comprou. */
export interface Review {
  id: string;
  rating: number;                 // 1 a 5
  title: string | null;
  comment: string;
  images: { id: string; url: string; mediaId: string | null }[];
  author: { name: string; id: string | null };   // "Maria S."
  /** Ligada a um pedido pago — mostre o selo de "compra verificada". */
  verifiedPurchase: boolean;
  /** Ocultada pela loja (só aparece nas SUAS avaliações). */
  hidden: boolean;
  isMine: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Média, total e quantas notas de cada estrela (para as barrinhas). */
export interface RatingSummary {
  average: number;
  count: number;
  distribution: Record<'1' | '2' | '3' | '4' | '5', number>;
}

/** Resposta de `reviews.canReview` — use para decidir o que mostrar na tela. */
export interface CanReview {
  canReview: boolean;
  reason: 'ALREADY_REVIEWED' | 'NOT_PURCHASED' | null;
  message: string;
  reviewId: string | null;
}

export interface ReviewInput {
  rating: number;
  title?: string | null;
  comment?: string;
  /** Ids de fotos já enviadas em `media.upload` (máx. 5). */
  mediaIds?: string[];
}

/** Arquivo na biblioteca de mídia da loja (upload no S3). */
export interface MediaAsset {
  id: string;
  kind: MediaKind;
  url: string;
  mimeType: string;
  sizeBytes: number;
  originalName: string | null;
  folder: string | null;
  uploadedByRm: string | null;
  createdAt: string;
}

/**
 * O que se manda como arquivo no upload.
 *
 * - No navegador: um `File` ou `Blob` (ex.: `input.files[0]`).
 * - No React Native: `{ uri, name, type }` — o objeto que o RN entende no
 *   FormData (a `uri` vem do ImagePicker).
 */
export type UploadInput =
  | Blob
  | { uri: string; name?: string; type?: string };

/** Item retornado na LISTAGEM (resumo). */
export interface ProductSummary {
  id: string;
  name: string;
  slug: string;
  type: ProductType;
  state: ProductState;
  brand: string | null;
  categoryId: string | null;
  priceFrom: number;
  priceTo: number;
  stock: number;
  image: string | null;
  variantsCount: number;
  /** Nota média e total de avaliações — para as estrelinhas no card. */
  rating: { average: number; count: number };
}

/** Produto DETALHADO (GET /products/:id). */
export interface Product {
  id: string;
  name: string;
  slug: string;
  type: ProductType;
  state: ProductState;
  publishAt: string | null;
  description: string;
  category: { id: string; name: string } | null;
  brand: { id: string; name: string } | null;
  seo: { metaTitle: string | null; metaDescription: string | null };
  tags: string[];
  collections: { id: string; name: string }[];
  options: { id: string; name: string; values: { id: string; value: string }[] }[];
  variants: ProductVariant[];
  images: ProductImage[];
  /** Vídeos (mesma estrutura das imagens, kind = 'VIDEO'). */
  videos: ProductImage[];
  /** Nota média e total de avaliações visíveis. */
  rating: RatingSummary;
  related: { kind: string; product: { id: string; name: string; slug: string } }[];
  createdAt: string;
}

export interface Paginated<T> { data: T[]; page: number; pageSize: number; total: number }
export interface NamedRef { id: string; name: string; slug?: string }

export interface Warehouse { id: string; name: string; isDefault: boolean }

export interface WebhookEndpointDef { id: string; url: string; description: string | null; events: string[]; active: boolean; createdAt: string }
export interface WebhookEndpointCreated extends WebhookEndpointDef { signingSecret: string }
export interface WebhookDelivery {
  id: string; endpointId: string; eventType: string;
  status: 'PENDING' | 'SUCCESS' | 'DEAD_LETTER'; attempts: number;
  lastStatusCode: number | null; lastResponseSnippet: string | null; lastError: string | null;
  nextAttemptAt: string; createdAt: string; updatedAt: string;
}

export interface SandboxCharge {
  id: string; method: PaymentMethod; amount: number; installments?: number;
  status: 'PENDING' | 'APPROVED' | 'DECLINED'; providerRef: string; orderId?: string;
  pix?: { copiaECola: string; qr: string };
  boleto?: { linhaDigitavel: string };
  card?: { brand: string; installments: number };
  createdAt: string;
}
export interface ShippingQuote {
  cepDestino: string; weightKg: number; zone: number;
  options: { service: string; price: number; etaDays: number }[];
}
export interface Shipment {
  id: string; orderId: string; service: string; cost: number; etaDays: number;
  status: string; trackingCode: string;
  events: { status: string; description: string; at: string }[]; createdAt: string;
}

export interface SalesReport {
  summary: { revenue: number; orders: number; itemsSold: number; ticketMedio: number };
  series: { day: string; revenue: number; orders: number }[];
}
export interface TopProduct { variantId: string; product: string; sku: string; variant: string | null; quantidade: number; receita: number }
export interface StockView {
  variantId: string; sku: string; minStock: number;
  onHand: number; reserved: number; available: number;
  warehouses: { warehouseId: string; warehouse: string; onHand: number; reserved: number; available: number }[];
}

export interface Customer { id: string; name: string; email: string }
export interface AuthResult { token: string; customer: Customer }

export interface CartItem { variantId: string; name: string; sku: string; unitPrice: number; quantity: number; subtotal: number }
export interface Cart { id: string; items: CartItem[]; total: number; itemCount: number }

export type PaymentMethod = 'CREDIT_CARD' | 'PIX' | 'BOLETO';
export interface OrderItem { variantId: string; productName: string; variantName: string | null; sku: string; unitPrice: number; quantity: number; subtotal: number }
export interface Order {
  id: string;
  status: 'PENDING' | 'PAID' | 'CANCELLED' | 'SHIPPED' | 'DELIVERED';
  total: number;
  items: OrderItem[];
  payment: { status: string; method: string; amount: number; transactionId: string } | null;
  createdAt: string;
}

// Entradas de criação de produto ---------------------------------------------
export interface CreateSimpleProduct {
  type?: 'SIMPLE';
  name: string; sku: string; price: number;
  description?: string; slug?: string; categoryId?: string; brandId?: string;
  tags?: string[]; collectionIds?: string[];
  state?: ProductState; publishAt?: string; metaTitle?: string; metaDescription?: string;
  stock?: number; minStock?: number; barcode?: string;
  weightGr?: number; heightMm?: number; widthMm?: number; depthMm?: number;
}
export interface VariantInput {
  sku: string; price: number; stock?: number; minStock?: number; barcode?: string;
  weightGr?: number; heightMm?: number; widthMm?: number; depthMm?: number;
  options: Record<string, string>; // { "Cor": "Preto", "Tamanho": "P" }
}
export interface CreateVariableProduct {
  type: 'VARIABLE';
  name: string; description?: string; slug?: string; categoryId?: string; brandId?: string;
  tags?: string[]; collectionIds?: string[];
  state?: ProductState; publishAt?: string; metaTitle?: string; metaDescription?: string;
  options: { name: string; values: string[] }[];
  variants: VariantInput[];
}

export class ApiError extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status; this.code = code; this.name = 'ApiError';
  }
}

export class EcommerceClient {
  private baseUrl: string;
  private apiKey: string;
  private studentRm?: string;
  customerToken?: string;

  constructor(opts: EcommerceClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.studentRm = opts.studentRm;
    this.customerToken = opts.customerToken;
  }

  setStudentRm(rm: string) { this.studentRm = rm; }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { 'X-API-Key': this.apiKey };
    if (this.studentRm) headers['X-Student-RM'] = this.studentRm;
    if (this.customerToken) headers['Authorization'] = `Bearer ${this.customerToken}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await fetch(`${this.baseUrl}${path}`, {
      method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return undefined as T;
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string } }).error;
      throw new ApiError(res.status, err?.code ?? 'ERROR', err?.message ?? res.statusText);
    }
    return json as T;
  }

  /**
   * Envia multipart/form-data. Não setamos Content-Type na mão de propósito: o
   * fetch precisa gerar o boundary sozinho — fixar o header quebra o upload.
   */
  private async upload<T>(path: string, file: UploadInput, fields: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    const headers: Record<string, string> = { 'X-API-Key': this.apiKey };
    if (this.studentRm) headers['X-Student-RM'] = this.studentRm;
    if (this.customerToken) headers['Authorization'] = `Bearer ${this.customerToken}`;

    const form = new FormData();
    // No React Native o objeto { uri, name, type } é o formato nativo esperado.
    form.append('file', file as unknown as Blob);
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) form.append(k, String(v));
    }

    const res = await fetch(`${this.baseUrl}${path}`, { method: 'POST', headers, body: form });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string } }).error;
      throw new ApiError(res.status, err?.code ?? 'ERROR', err?.message ?? res.statusText);
    }
    return json as T;
  }

  private qs(params: Record<string, unknown>): string {
    const s = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]),
    ).toString();
    return s ? `?${s}` : '';
  }

  // ---------------------------------------------------------- Catálogo (escrita = app do grupo)
  categories = {
    list: () => this.request<NamedRef[]>('GET', '/categories'),
    create: (name: string) => this.request<NamedRef>('POST', '/categories', { name }),
  };
  brands = {
    list: () => this.request<NamedRef[]>('GET', '/brands'),
    create: (name: string) => this.request<NamedRef>('POST', '/brands', { name }),
  };
  collections = {
    list: () => this.request<NamedRef[]>('GET', '/collections'),
    create: (name: string) => this.request<NamedRef>('POST', '/collections', { name }),
  };
  tags = { list: () => this.request<{ id: string; name: string }[]>('GET', '/tags') };

  products = {
    list: (params: {
      search?: string; categoryId?: string; brandId?: string; collectionId?: string;
      tag?: string; state?: ProductState; minPrice?: number; maxPrice?: number;
      page?: number; pageSize?: number;
    } = {}) => this.request<Paginated<ProductSummary>>('GET', `/products${this.qs(params)}`),
    get: (id: string) => this.request<Product>('GET', `/products/${id}`),
    create: (data: CreateSimpleProduct | CreateVariableProduct) => this.request<Product>('POST', '/products', data),
    update: (id: string, data: Partial<{
      name: string; description: string; slug: string; state: ProductState; publishAt: string | null;
      categoryId: string | null; brandId: string | null; tags: string[]; collectionIds: string[];
      metaTitle: string; metaDescription: string;
    }>) => this.request<Product>('PUT', `/products/${id}`, data),
    remove: (id: string) => this.request<void>('DELETE', `/products/${id}`),
    setRelations: (id: string, kind: 'RELATED' | 'CROSS_SELL' | 'UPSELL', relatedIds: string[]) =>
      this.request('PUT', `/products/${id}/relations`, { kind, relatedIds }),
    /** Vincula uma mídia já existente: por `mediaId` (upload) ou por `url` externa. */
    addImage: (id: string, data: { mediaId?: string; url?: string; variantId?: string; position?: number; isPrimary?: boolean }) =>
      this.request<ProductImage>('POST', `/products/${id}/images`, data),
    /** Ajusta uma mídia já vinculada: capa (`isPrimary`), ordem ou variante. */
    updateImage: (imageId: string, data: { isPrimary?: boolean; position?: number; variantId?: string | null }) =>
      this.request<ProductImage>('PATCH', `/images/${imageId}`, data),
    /** Desvincula a mídia do produto (o arquivo continua na biblioteca). */
    removeImage: (imageId: string) => this.request<void>('DELETE', `/images/${imageId}`),
    /** Sobe o arquivo E já vincula ao produto, numa chamada só. */
    addMedia: (id: string, file: UploadInput, opts: { variantId?: string; isPrimary?: boolean; position?: number } = {}) =>
      this.upload<ProductImage & { media: MediaAsset }>(`/products/${id}/media`, file, opts),
  };

  // ------------------------------------------------------------- Avaliações
  reviews = {
    /** Avaliações de um produto + média e distribuição. Não exige login. */
    list: (productId: string, params: {
      rating?: number; withPhotos?: boolean;
      sort?: 'recent' | 'rating_desc' | 'rating_asc';
      page?: number; pageSize?: number;
    } = {}) =>
      this.request<Paginated<Review> & { summary: RatingSummary }>(
        'GET', `/products/${productId}/reviews${this.qs(params)}`,
      ),
    /** O cliente logado pode avaliar? Chame antes de mostrar o formulário. */
    canReview: (productId: string) =>
      this.request<CanReview>('GET', `/products/${productId}/reviews/can-review`),
    /** Cria a avaliação (exige pedido pago com o produto). */
    create: (productId: string, data: ReviewInput) =>
      this.request<Review>('POST', `/products/${productId}/reviews`, data),
    update: (reviewId: string, data: Partial<ReviewInput>) =>
      this.request<Review>('PATCH', `/reviews/${reviewId}`, data),
    remove: (reviewId: string) => this.request<void>('DELETE', `/reviews/${reviewId}`),
    /** As avaliações do cliente logado, com o produto de cada uma. */
    mine: () => this.request<{ data: (Review & { product: { id: string; name: string; slug: string } })[] }>('GET', '/me/reviews'),
    /** LOJA: lista tudo, inclusive o que foi ocultado. */
    storeList: (params: { productId?: string; rating?: number; hidden?: boolean; page?: number; pageSize?: number } = {}) =>
      this.request<Paginated<any>>('GET', `/store/reviews${this.qs(params)}`),
    /** LOJA: oculta ou volta a exibir uma avaliação. */
    setHidden: (reviewId: string, hidden: boolean, reason?: string) =>
      this.request('PATCH', `/store/reviews/${reviewId}`, { hidden, reason }),
  };

  // ------------------------------------------------------------- Mídia (upload S3)
  media = {
    /** Envia uma imagem ou vídeo e devolve a URL pública. */
    upload: (file: UploadInput, opts: { folder?: string } = {}) =>
      this.upload<MediaAsset>('/uploads', file, opts),
    list: (params: { kind?: MediaKind; folder?: string; page?: number; pageSize?: number } = {}) =>
      this.request<Paginated<MediaAsset>>('GET', `/media${this.qs(params)}`),
    get: (id: string) => this.request<MediaAsset>('GET', `/media/${id}`),
    /** Espaço usado, cota da loja e limites de upload. */
    usage: () => this.request<{
      files: number; usedBytes: number; quotaBytes: number; availableBytes: number;
      usedPercent: number; maxFileBytes: number; acceptedMimeTypes: string[];
    }>('GET', '/media/usage'),
    /** Apaga do bucket. Use `force` se o arquivo estiver vinculado a algum produto. */
    remove: (id: string, force = false) =>
      this.request<{ deleted: boolean; unlinkedFrom: number }>('DELETE', `/media/${id}${force ? '?force=true' : ''}`),
  };

  variants = {
    add: (productId: string, data: VariantInput) => this.request<ProductVariant>('POST', `/products/${productId}/variants`, data),
    // Obs.: o estoque NÃO é editado aqui — use `inventory.receive/adjust`.
    update: (variantId: string, data: Partial<{ price: number; minStock: number; barcode: string; active: boolean }>) =>
      this.request<ProductVariant>('PATCH', `/variants/${variantId}`, data),
    remove: (variantId: string) => this.request<void>('DELETE', `/variants/${variantId}`),
  };

  // ------------------------------------------------------------------ Estoque
  warehouses = {
    list: () => this.request<Warehouse[]>('GET', '/warehouses'),
    create: (name: string) => this.request<Warehouse>('POST', '/warehouses', { name }),
  };

  inventory = {
    /** Saldo por depósito: onHand (físico), reserved, available (disponível). */
    stock: (variantId: string) => this.request<StockView>('GET', `/variants/${variantId}/stock`),
    /** Entrada de estoque (compra/reposição). */
    receive: (variantId: string, quantity: number, opts: { warehouseId?: string; reason?: string } = {}) =>
      this.request<StockView>('POST', `/variants/${variantId}/stock/receive`, { quantity, ...opts }),
    /** Ajuste: define o onHand do depósito (inventário/correção). */
    adjust: (variantId: string, onHand: number, opts: { warehouseId?: string; reason?: string } = {}) =>
      this.request<StockView>('POST', `/variants/${variantId}/stock/adjust`, { onHand, ...opts }),
    /** Histórico de movimentação (RECEIVE/SALE/ADJUST/RESERVE/RELEASE). */
    movements: (variantId: string, params: { type?: string; page?: number; pageSize?: number } = {}) =>
      this.request('GET', `/variants/${variantId}/stock/movements${this.qs(params)}`),
    /** Inventário: submete contagem por depósito e gera ajustes. */
    counts: (counts: { variantId: string; warehouseId: string; counted: number }[]) =>
      this.request('POST', '/inventory/counts', { counts }),
    /** Força a expiração de reservas vencidas do grupo (útil em testes). */
    runExpiration: () => this.request<{ expiredOrders: number }>('POST', '/inventory/run-expiration'),
  };

  // -------------------------------------------------------------- Auth cliente
  auth = {
    register: async (data: { name: string; email: string; password: string }) => {
      const r = await this.request<AuthResult>('POST', '/auth/register', data);
      this.customerToken = r.token; return r;
    },
    login: async (data: { email: string; password: string }) => {
      const r = await this.request<AuthResult>('POST', '/auth/login', data);
      this.customerToken = r.token; return r;
    },
    me: () => this.request<Customer>('GET', '/auth/me'),
    logout: () => { this.customerToken = undefined; },
  };

  // ------------------------------------------------------------------ Carrinho (por VARIANTE)
  cart = {
    get: () => this.request<Cart>('GET', '/cart'),
    addItem: (variantId: string, quantity: number) => this.request<Cart>('POST', '/cart/items', { variantId, quantity }),
    setQuantity: (variantId: string, quantity: number) => this.request<Cart>('PATCH', `/cart/items/${variantId}`, { quantity }),
    removeItem: (variantId: string) => this.request<Cart>('DELETE', `/cart/items/${variantId}`),
    clear: () => this.request<Cart>('DELETE', '/cart'),
  };

  // ------------------------------------------------------------------ Webhooks
  webhooks = {
    /** Catálogo de tipos de evento que o backend emite. */
    events: () => this.request<{ events: string[] }>('GET', '/webhooks/events'),
    list: () => this.request<WebhookEndpointDef[]>('GET', '/webhooks'),
    /** Cria um webhook. O `signingSecret` retornado é mostrado UMA vez — guarde-o. */
    create: (data: { url: string; description?: string; events?: string[] }) =>
      this.request<WebhookEndpointCreated>('POST', '/webhooks', data),
    get: (id: string) => this.request<WebhookEndpointDef>('GET', `/webhooks/${id}`),
    update: (id: string, data: Partial<{ url: string; description: string; events: string[]; active: boolean }>) =>
      this.request<WebhookEndpointDef>('PATCH', `/webhooks/${id}`, data),
    remove: (id: string) => this.request<void>('DELETE', `/webhooks/${id}`),
    rotateSecret: (id: string) => this.request<{ id: string; signingSecret: string }>('POST', `/webhooks/${id}/rotate-secret`),
    /** Envia um evento de teste (webhook.ping) ao endpoint. */
    ping: (id: string) => this.request<WebhookDelivery>('POST', `/webhooks/${id}/ping`),
    /** Histórico de entregas (inspector). */
    deliveries: (params: { endpointId?: string; status?: 'PENDING' | 'SUCCESS' | 'DEAD_LETTER'; page?: number; pageSize?: number } = {}) =>
      this.request<Paginated<WebhookDelivery>>('GET', `/webhooks/deliveries${this.qs(params)}`),
    resend: (deliveryId: string) => this.request<WebhookDelivery>('POST', `/webhooks/deliveries/${deliveryId}/resend`),
    /** Força uma passada do relay (útil em testes). */
    deliverNow: () => this.request<{ delivered: number }>('POST', '/webhooks/deliver-now'),
  };

  // ------------------------------------------------------- Sandbox (FAKE) — PSP e frete
  sandbox = {
    payments: {
      /** Cria uma cobrança. Cartão resolve na hora; PIX/boleto ficam PENDING até settle(). */
      create: (data: { method: PaymentMethod; amount?: number; orderId?: string; installments?: number; simulate?: 'approve' | 'decline' }) =>
        this.request<SandboxCharge>('POST', '/sandbox/payments', data),
      get: (id: string) => this.request<SandboxCharge>('GET', `/sandbox/payments/${id}`),
      /** Confirma um PIX/boleto → dispara webhook payment.approved/declined (e paga o pedido, se ligado). */
      settle: (id: string, simulate: 'approve' | 'decline' = 'approve') =>
        this.request<SandboxCharge>('POST', `/sandbox/payments/${id}/settle`, { simulate }),
    },
    subscriptions: {
      create: (data: { amount: number; intervalDays: number; customerId?: string }) =>
        this.request('POST', '/sandbox/subscriptions', data),
      advance: (id: string) => this.request('POST', `/sandbox/subscriptions/${id}/advance`),
    },
    shipping: {
      /** Cotação por CEP (usa o peso das variantes do pedido, se orderId for passado). */
      quote: (data: { cepDestino: string; orderId?: string; items?: { weightGr: number; quantity: number }[] }) =>
        this.request<ShippingQuote>('POST', '/sandbox/shipping/quote', data),
      /** Despacha um pedido: cria envio + rastreamento. */
      createShipment: (data: { orderId: string; service: 'PAC' | 'SEDEX' | 'TRANSPORTADORA' | 'RETIRADA_LOJA'; cepDestino: string }) =>
        this.request<Shipment>('POST', '/sandbox/shipments', data),
      getShipment: (id: string) => this.request<Shipment>('GET', `/sandbox/shipments/${id}`),
      /** Avança o rastreamento → dispara webhook shipment.updated. */
      advanceShipment: (id: string) => this.request<Shipment>('POST', `/sandbox/shipments/${id}/advance`),
    },
  };

  // ----------------------------------------------------------------- Ensino (gamificação)
  teaching = {
    /** Painel do grupo: missões, XP, badges, nota e o que falta (auto-avalia). */
    dashboard: () => this.request('GET', '/teaching/dashboard'),
    ranking: () => this.request('GET', '/teaching/ranking'),
    /** Enviar para correção (snapshot imutável + nota). */
    submit: () => this.request<{ submissionId: string; grade: number; missoesCumpridas: number }>('POST', '/teaching/submit'),
    settings: (data: { rankingOptOut?: boolean }) => this.request('PUT', '/teaching/settings', data),
  };

  // ----------------------------------------------------------------- Relatórios
  // (Para CSV, acrescente ?format=csv na URL — o SDK devolve só JSON.)
  reports = {
    sales: (params: { from?: string; to?: string } = {}) => this.request<SalesReport>('GET', `/reports/sales${this.qs(params)}`),
    topProducts: (params: { from?: string; to?: string; by?: 'qty' | 'revenue'; limit?: number } = {}) =>
      this.request<{ data: TopProduct[] }>('GET', `/reports/top-products${this.qs(params)}`),
    customers: (params: { from?: string; to?: string } = {}) => this.request('GET', `/reports/customers${this.qs(params)}`),
    inventory: () => this.request('GET', '/reports/inventory'),
  };

  // -------------------------------------------------------------------- Pedidos
  orders = {
    checkout: () => this.request<Order>('POST', '/orders/checkout'),
    list: () => this.request<Order[]>('GET', '/orders'),
    get: (id: string) => this.request<Order>('GET', `/orders/${id}`),
    pay: (id: string, data: { method: PaymentMethod; simulate?: 'approve' | 'decline' }) =>
      this.request<Order>('POST', `/orders/${id}/pay`, data),
    cancel: (id: string) => this.request<Order>('POST', `/orders/${id}/cancel`),
    /** Linha do tempo do pedido (mudanças de status). */
    timeline: (id: string) => this.request('GET', `/orders/${id}/timeline`),
    /** Comprar novamente: recria o carrinho a partir do pedido. */
    reorder: (id: string) => this.request<{ cartId: string; adicionados: number; indisponiveis: string[] }>('POST', `/orders/${id}/reorder`),
  };

  // ---------------------------------------------- Perfil do cliente (endereços/favoritos)
  profile = {
    addresses: {
      list: () => this.request('GET', '/customers/me/addresses'),
      add: (data: { cep: string; street: string; number: string; city: string; state: string; type?: 'SHIPPING' | 'BILLING'; isDefault?: boolean; recipientName?: string; complement?: string; district?: string }) =>
        this.request('POST', '/customers/me/addresses', data),
      remove: (id: string) => this.request<void>('DELETE', `/customers/me/addresses/${id}`),
    },
    favorites: {
      list: () => this.request('GET', '/customers/me/favorites'),
      add: (variantId: string) => this.request('POST', '/customers/me/favorites', { variantId }),
      remove: (variantId: string) => this.request<void>('DELETE', `/customers/me/favorites/${variantId}`),
    },
  };

  // ------------------------------------------------- Gestão pela LOJA (X-API-Key)
  store = {
    orders: {
      list: (params: { status?: string; customerId?: string; page?: number; pageSize?: number } = {}) => this.request('GET', `/store/orders${this.qs(params)}`),
      get: (id: string) => this.request('GET', `/store/orders/${id}`),
      /** Pedido manual para um cliente (reserva estoque; opcional já pago). */
      createManual: (data: { customerId: string; items: { variantId: string; quantity: number }[]; markAsPaid?: boolean }) => this.request('POST', '/store/orders', data),
      transition: (id: string, to: 'FULFILLED' | 'SHIPPED' | 'DELIVERED', note?: string) => this.request('POST', `/store/orders/${id}/transition`, { to, note }),
      refund: (id: string) => this.request('POST', `/store/orders/${id}/refund`),
      comments: {
        list: (id: string) => this.request('GET', `/store/orders/${id}/comments`),
        add: (id: string, body: string) => this.request('POST', `/store/orders/${id}/comments`, { body }),
      },
    },
    customers: {
      list: (params: { search?: string; page?: number; pageSize?: number } = {}) => this.request('GET', `/store/customers${this.qs(params)}`),
    },
    segments: {
      list: () => this.request('GET', '/customer-segments'),
      create: (name: string) => this.request('POST', '/customer-segments', { name }),
      addMember: (segmentId: string, customerId: string) => this.request('POST', `/customer-segments/${segmentId}/members`, { customerId }),
      members: (segmentId: string) => this.request('GET', `/customer-segments/${segmentId}/members`),
    },
    runAbandonment: () => this.request<{ abandonados: number }>('POST', '/store/carts/run-abandonment'),
    /** Config do grupo (idioma/moeda/fuso). */
    settings: {
      get: () => this.request<{ locale: string; currency: string; timezone: string }>('GET', '/store/settings'),
      update: (data: Partial<{ locale: string; currency: string; timezone: string }>) => this.request('PUT', '/store/settings', data),
    },
    /** LGPD. */
    lgpd: {
      exportCustomer: (customerId: string) => this.request('GET', `/store/customers/${customerId}/export`),
      anonymizeCustomer: (customerId: string) => this.request<{ anonymized: boolean; customerId: string }>('DELETE', `/store/customers/${customerId}`),
    },
  };

  // ------------------------------------------------- Comunicações fake
  comms = {
    invoice: (orderId: string) => this.request<{ number: number; orderId: string; xml: string; createdAt: string }>('GET', `/orders/${orderId}/invoice`),
    emailOutbox: (params: { template?: string; page?: number; pageSize?: number } = {}) => this.request('GET', `/email-outbox${this.qs(params)}`),
    sync: (system: 'erp' | 'crm' | 'marketplace', payload: Record<string, unknown>) => this.request('POST', `/sandbox/${system}/sync`, payload),
  };
}
