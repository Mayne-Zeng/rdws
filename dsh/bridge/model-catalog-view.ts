import { isRecord } from './access.ts';
import { publicFields } from './session-view.ts';

function named(
  value: unknown,
): value is Record<string, unknown> & { id: string; name: string } {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.name === 'string'
  );
}

const badgeSegments = new Intl.Segmenter();
function isBadgeText(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 256 ||
    /[\r\n\u2028\u2029]/u.test(value)
  )
    return false;
  return Array.from(badgeSegments.segment(value)).length <= 12;
}

function badgeView(value: unknown) {
  if (
    !isRecord(value) ||
    !['neutral', 'info', 'success', 'warning'].some(
      (tone) => tone === value.tone,
    )
  )
    return;
  const { text, tone } = value;
  if (isBadgeText(text)) return { text, tone };
  if (isRecord(text) && isBadgeText(text.en))
    return {
      tone,
      text: Object.fromEntries(
        Object.entries(text).filter(
          ([locale, label]) =>
            /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/.test(locale) &&
            isBadgeText(label),
        ),
      ),
    };
}

function modelView(value: unknown) {
  if (!named(value)) return;
  const reasoning = isRecord(value.reasoning) ? value.reasoning : undefined;
  const efforts = Array.isArray(reasoning?.efforts)
    ? reasoning.efforts.filter(named)
    : undefined;
  return {
    id: value.id,
    name: value.name,
    ...(typeof value.description === 'string'
      ? { description: value.description }
      : {}),
    ...(reasoning && efforts
      ? {
          reasoning: {
            efforts: efforts.map((effort) =>
              publicFields(effort, {
                id: 'text',
                name: 'text',
                description: 'text',
              }),
            ),
            ...(efforts.some(({ id }) => id === reasoning.defaultEffort)
              ? { defaultEffort: reasoning.defaultEffort }
              : {}),
          },
        }
      : {}),
    badge: badgeView(value.badge),
  };
}

export function publicModelCatalogValue(value: unknown) {
  if (
    !isRecord(value) ||
    !isRecord(value.default) ||
    typeof value.default.provider !== 'string' ||
    typeof value.default.model !== 'string' ||
    !Array.isArray(value.groups) ||
    !Array.isArray(value.routableProviders) ||
    !Array.isArray(value.failures) ||
    !value.failures.every(named)
  )
    return;
  const groups = value.groups.filter(named).flatMap((group) => {
    if (!Array.isArray(group.models)) return [];
    const models = group.models
      .map(modelView)
      .filter((item) => item !== undefined);
    return models.length ? [{ id: group.id, name: group.name, models }] : [];
  });
  const ids = new Set(groups.map(({ id }) => id));
  return {
    default: publicFields(value.default, {
      provider: 'text',
      model: 'text',
      reasoningEffort: 'text',
    }),
    groups,
    routableProviders: [
      ...new Set(
        value.routableProviders.filter(
          (provider): provider is string =>
            typeof provider === 'string' && ids.has(provider),
        ),
      ),
    ],
    failures: value.failures.map(({ id, name }) => ({
      id,
      name,
      message: '供应商模型目录暂不可用',
    })),
  };
}
