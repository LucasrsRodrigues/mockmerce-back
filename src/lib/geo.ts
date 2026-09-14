import { badRequest } from './errors.js';

/**
 * Geografia (f6-locations). Funções PURAS: entram números, saem números.
 *
 * Ficam aqui, fora dos módulos, porque três lugares diferentes precisam delas —
 * pontos de retirada (distância), frete (origem) e rastreio (trajeto) — e porque
 * função pura é a mais fácil de testar e de explicar em aula.
 */

export interface Coords {
  latitude: number;
  longitude: number;
}

/** Raio médio da Terra em km (usado na fórmula de Haversine). */
const RAIO_TERRA_KM = 6371;

/** Onde a loja fica quando o grupo ainda não configurou: centro de São Paulo. */
export const DEFAULT_ORIGIN: Coords = { latitude: -23.5505, longitude: -46.6333 };

const rad = (graus: number) => (graus * Math.PI) / 180;

/** Valida um par de coordenadas vindo do cliente. */
export function parseCoords(lat: unknown, lng: unknown): Coords | null {
  if (lat === undefined || lat === null || lng === undefined || lng === null) return null;
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw badRequest('Coordenadas inválidas: latitude e longitude devem ser números.');
  }
  if (latitude < -90 || latitude > 90) throw badRequest('latitude deve estar entre -90 e 90.');
  if (longitude < -180 || longitude > 180) throw badRequest('longitude deve estar entre -180 e 180.');
  return { latitude, longitude };
}

/**
 * Distância em km entre dois pontos, pela fórmula de Haversine — que mede sobre
 * a CURVA da Terra, não em linha reta no plano. Para distâncias urbanas a
 * diferença é pequena, mas usar Pitágoras com latitude/longitude erra feio
 * conforme se afasta do equador (um grau de longitude "encolhe" perto dos polos).
 *
 * É distância em linha reta (voo de pássaro), não distância de rua.
 */
export function distanceKm(a: Coords, b: Coords): number {
  const dLat = rad(b.latitude - a.latitude);
  const dLng = rad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * RAIO_TERRA_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Arredonda para 2 casas — precisão de ~10 m, suficiente para exibir. */
export function roundKm(km: number): number {
  return Math.round(km * 100) / 100;
}

/**
 * Ponto a `fracao` do caminho entre dois pontos (0 = origem, 1 = destino).
 *
 * Interpolação LINEAR: o resultado é uma linha reta, não o trajeto de uma
 * transportadora de verdade. É o bastante para o pin andar no mapa enquanto o
 * status do envio avança no sandbox.
 */
export function interpolate(origem: Coords, destino: Coords, fracao: number): Coords {
  const t = Math.max(0, Math.min(1, fracao));
  return {
    latitude: origem.latitude + (destino.latitude - origem.latitude) * t,
    longitude: origem.longitude + (destino.longitude - origem.longitude) * t,
  };
}

/**
 * Ordena por proximidade de um ponto de referência, anexando a distância.
 *
 * Feito em memória de propósito: uma loja tem punhado de pontos de retirada, e
 * fazer Haversine em SQL exigiria uma extensão do Postgres (PostGIS) só para
 * ordenar meia dúzia de linhas.
 */
export function sortByDistance<T extends Coords>(itens: T[], de: Coords | null): (T & { distanceKm: number | null })[] {
  if (!de) return itens.map((i) => ({ ...i, distanceKm: null }));
  return itens
    .map((i) => ({ ...i, distanceKm: roundKm(distanceKm(de, i)) }))
    .sort((a, b) => a.distanceKm - b.distanceKm);
}
