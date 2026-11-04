import { round } from '../util.mjs';
import { array, mean, modelSchema, number, result, text, xml } from './helpers.mjs';
import { validInn } from './documents.mjs';
import { createPptx } from './pptx.mjs';

const NEGATIVE = /плохо|ужас|отврат|не\s+работ|слом|обман|мошен|жалоб|проблем|дорого|долго|хам|гряз|брак|просроч|негатив/i;
const POSITIVE = /отличн|хорош|спасибо|быстро|качествен|рекоменд|удобн|прекрас|замечател|довол/i;
const TOXIC = /идиот|тупой|дебил|ублюд|ненавиж|смерт|убью|урод/i;

export function sentiment(text) {
  const negative = NEGATIVE.test(text), positive = POSITIVE.test(text);
  if (negative && !positive) return { label: 'negative', score: -0.75 };
  if (positive && !negative) return { label: 'positive', score: 0.75 };
  if (negative && positive) return { label: 'mixed', score: 0 };
  return { label: 'neutral', score: 0 };
}

export function chatVoice(input) {
  const message = text(input.message, 'message', 100000);
  const handoff = /оператор|человек|директор|юрист|жалоба|начальник|экстрен|авар/i.test(message);
  const contact = message.match(/(?:\+7|8)[\s(~-]*\d{3}[\s)~-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/)?.[0] || message.match(/[\w.+-]+@[\w.-]+\.[A-Za-zА-Яа-я]{2,}/u)?.[0] || null;
  const name = message.match(/(?:меня\s+зовут|мо[её]\s+имя)\s+([\p{L}-]{2,50})/iu)?.[1] || null;
  const appointment = message.match(/(\d{2}[./-]\d{2}[./-]\d{4})(?:\s+(?:в\s+)?(\d{2}:\d{2}))?/u);
  const intent = /заказ|купить|оплат|сч[её]т/i.test(message) ? 'order' : /запис|при[её]м|встреч|время/i.test(message) ? 'appointment' : /цен|стоим|тариф/i.test(message) ? 'pricing' : /проблем|ошибка|не\s+работ/i.test(message) ? 'support' : 'inquiry';
  const needsClarification = !handoff && !contact && ['order', 'appointment'].includes(intent);
  const reply = handoff ? 'Передаю диалог оператору вместе с историей. Срочные угрозы жизни — обратитесь в экстренную службу.' : needsClarification ? 'Уточните, пожалуйста, телефон или email для подтверждения.' : intent === 'pricing' ? 'Подготовил запрос точной стоимости; подтвердите параметры перед оформлением.' : 'Принял. Проверьте данные и подтвердите следующее действие.';
  const lead = { intent, name, contact, appointmentAt: appointment ? `${appointment[1]} ${appointment[2] || ''}`.trim() : null, source: input.channel || 'api', status: handoff ? 'handoff' : needsClarification ? 'needs_details' : 'qualified_draft' };
  const effects = !handoff && !needsClarification && intent === 'appointment' ? [{ type: 'calendar.book', integration: input.integration || 'calendar', payload: { lead, note: message }, consequential: true }] : [];
  return result({ reply, lead, nextState: handoff ? 'human_handoff' : needsClarification ? 'collect_contact' : 'awaiting_confirmation', handoff, historyPreserved: true }, { effects, usage: { unit: 'dialog', quantity: 1 } });
}

export function reputation(input) {
  const reviews = array(input.reviews, 'reviews', 50000);
  const items = reviews.map((review, index) => {
    text(review.text, `reviews[${index}].text`, 200000);
    const tone = sentiment(review.text);
    const topics = [...new Set(['доставка', 'цена', 'качество', 'поддержка', 'сроки'].filter((topic) => review.text.toLowerCase().includes(topic)))];
    return { ...review, tone, topics, responseDraft: tone.label === 'negative' ? 'Спасибо за обратную связь. Нам жаль, что возникла такая ситуация. Уточните, пожалуйста, детали, чтобы мы могли проверить случай и предложить решение.' : 'Спасибо за ваш отзыв и за то, что поделились опытом!' };
  });
  const counts = Object.groupBy(items, (item) => item.tone.label);
  const averageRating = reviews.filter((r) => Number.isFinite(r.rating)).map((r) => r.rating);
  const effects = items.filter((item) => input.publish === true).map((item) => ({ type: 'review.publish_response', integration: item.platform || input.integration || 'reviews', payload: { reviewId: item.id, text: item.responseDraft }, consequential: true }));
  return result({ reviews: items, summary: { total: items.length, negative: counts.negative?.length || 0, neutral: counts.neutral?.length || 0, positive: counts.positive?.length || 0, mixed: counts.mixed?.length || 0, averageRating: averageRating.length ? round(mean(averageRating), 2) : null }, escalation: items.filter((item) => item.tone.label === 'negative' && item.rating <= 2).map((item) => item.id) }, { effects, usage: { unit: 'review', quantity: Math.max(1, reviews.length) } });
}

export function applicationScoring(input) {
  const inn = text(input.inn, 'inn', 12);
  const registry = input.registry || {};
  const financials = input.financials || {};
  const reasons = [];
  if (!validInn(inn)) reasons.push({ code: 'invalid_inn', weight: 100 });
  if (registry.bankruptcy) reasons.push({ code: 'bankruptcy', weight: 100 });
  if (registry.disqualified) reasons.push({ code: 'disqualified', weight: 90 });
  if (registry.taxDebtMinor > 0) reasons.push({ code: 'tax_debt', weight: 35 });
  if ((registry.enforcementCount || 0) > 0) reasons.push({ code: 'enforcement', weight: 30 });
  if ((registry.activeLawsuitsCount || 0) > 3) reasons.push({ code: 'lawsuits', weight: 15 });
  if (Number.isFinite(financials.debtToEquity) && financials.debtToEquity > 3) reasons.push({ code: 'high_leverage', weight: 25 });
  if (Number.isFinite(financials.currentRatio) && financials.currentRatio < 1) reasons.push({ code: 'liquidity', weight: 25 });
  if (!Object.keys(registry).length) reasons.push({ code: 'registry_data_missing', weight: 20 });
  const score = Math.max(0, 100 - reasons.reduce((sum, reason) => sum + reason.weight, 0));
  const decision = reasons.some((r) => r.weight >= 90) ? 'reject' : score >= 75 ? 'approve_draft' : 'manual_review';
  return result({ inn, score, decision, reasons, evidence: registry.evidence || null, policy: { approveAt: 75, hardStopWeight: 90 }, humanReviewRequired: decision !== 'approve_draft', disclaimer: 'Скоринг по переданным данным и политике, а не гарантия возврата/надёжности.' }, { effects: [{ type: 'crm.update_application', integration: input.integration || 'crm', payload: { inn, score, decision }, consequential: true }], usage: { unit: 'application', quantity: 1 } });
}

export async function contentGeneration(input, context) {
  const topic = text(input.topic, 'topic', 100000);
  const channels = input.channels || ['telegram'];
  let items;
  if (input.template) {
    items = channels.map((channel) => ({ channel, text: input.template.replaceAll('{topic}', topic), media: [] }));
  } else {
    const generated = await context.model.complete({ system: 'Create factual marketing drafts. Never invent cases, discounts or performance claims. Return JSON.', prompt: JSON.stringify({ topic, channels, tone: input.tone || 'professional', facts: input.facts || [] }), schema: modelSchema({ items: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['channel', 'text'], properties: { channel: { type: 'string' }, text: { type: 'string', minLength: 1 }, media: { type: 'array', items: { type: 'string' } } } } } }) });
    items = generated.items;
  }
  const effects = input.schedule ? items.map((item) => ({ type: 'content.schedule', integration: item.channel, payload: { ...item, publishAt: input.schedule }, consequential: true })) : [];
  return result({ items, status: 'draft', reviewRequired: true }, { effects, usage: { unit: 'post', quantity: items.length } });
}

function renderTemplate(template, contact) {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => String(contact[key] ?? ''));
}
export function emailMarketing(input) {
  const contacts = array(input.contacts, 'contacts', 100000);
  const template = text(input.template, 'template', 500000);
  const segment = input.segment || {};
  const selected = contacts.filter((contact) => contact.consentAt && !contact.optedOutAt && (!segment.tag || (contact.tags || []).includes(segment.tag)) && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contact.email));
  const excluded = contacts.length - selected.length;
  requireLimit(selected.length, 500);
  const messages = selected.map((contact) => ({ to: contact.email, subject: renderTemplate(input.subject || 'Сообщение', contact), text: renderTemplate(template, contact), unsubscribeRequired: true }));
  const effects = input.enqueue ? messages.map((message) => ({ type: 'email.send', integration: input.integration || 'smtp', payload: message, consequential: true, idempotencyKey: `email:${input.campaignId}:${message.to}` })) : [];
  return result({ selected: selected.length, excluded, messages, consentPolicy: 'consent required; opted out and invalid addresses excluded', status: input.enqueue ? 'awaiting_approval' : 'preview' }, { effects, usage: { unit: 'email', quantity: Math.max(1, messages.length) } });
}

function requireLimit(value, max) {
  if (value > max) throw Object.assign(new Error(`Batch exceeds ${max} recipients`), { status: 422, code: 'batch_limit' });
}

export async function presentation(input) {
  const title = text(input.title, 'title', 500);
  const source = text(input.text, 'text', 1000000);
  const brand = input.brand || {};
  const paragraphs = source.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const slides = paragraphs.slice(0, 30).map((paragraph, index) => {
    const lines = paragraph.split('\n').map((x) => x.trim()).filter(Boolean);
    return { title: index === 0 ? title : lines[0].slice(0, 120), bullets: (index === 0 ? lines : lines.slice(1)).flatMap((line) => line.split(/(?<=[.!?])\s+/)).slice(0, 7) };
  });
  if (!slides.length) slides.push({ title, bullets: [] });
  const pptx = createPptx({ title, slides, brand });
  const html = `<!doctype html><html lang="ru"><meta charset="utf-8"><title>${xml(title)}</title><style>body{font-family:Arial,sans-serif;background:#eef2fb;color:#202738}section{width:1120px;min-height:560px;margin:30px auto;padding:64px;background:white;border-top:12px solid #${String(brand.color || '4453E1').replace('#', '')}}h1{font-size:44px}li{font-size:28px;margin:20px 0}</style>${slides.map((slide) => `<section><h1>${xml(slide.title)}</h1><ul>${slide.bullets.map((b) => `<li>${xml(b)}</li>`).join('')}</ul></section>`).join('')}</html>`;
  return result({ title, slideCount: slides.length, slides, editable: true }, { artifacts: [{ kind: 'presentation.pptx', base64: pptx.toString('base64'), metadata: { filename: `${title.replace(/[^a-zA-Zа-яА-Я0-9_-]/giu, '_')}.pptx`, editable: true } }, { kind: 'presentation.html', content: html }], usage: { unit: 'presentation', quantity: 1 } });
}

const PROTECTED = /пол|женщин|мужчин|возраст|националь|религ|инвалид|беремен|семейн|дет[ейи]/i;
export function recruiting(input) {
  const requirements = array(input.requirements, 'requirements', 1000);
  const resumes = array(input.resumes, 'resumes', 10000);
  const totalWeight = requirements.reduce((sum, r) => sum + (r.weight || 1), 0);
  const candidates = resumes.map((resume, index) => {
    const source = text(resume.text, `resumes[${index}].text`, 1000000);
    const lower = source.toLowerCase();
    const skills = requirements.map((requirement) => ({ skill: requirement.skill, matched: lower.includes(requirement.skill.toLowerCase()), weight: requirement.weight || 1 }));
    const score = Math.round(100 * skills.filter((s) => s.matched).reduce((sum, s) => sum + s.weight, 0) / Math.max(totalWeight, 1));
    const protectedAttributesFound = PROTECTED.test(source);
    return { id: resume.id || index, score, matched: skills.filter((s) => s.matched).map((s) => s.skill), missing: skills.filter((s) => !s.matched).map((s) => s.skill), interviewQuestions: skills.filter((s) => !s.matched).map((s) => `Уточните опыт работы с ${s.skill}.`), protectedAttributesExcludedFromScore: protectedAttributesFound, decision: 'ranked_for_human_review' };
  }).sort((a, b) => b.score - a.score);
  return result({ candidates, protectedCriteriaUsed: false, humanReviewRequired: true }, { usage: { unit: 'resume', quantity: Math.max(1, resumes.length) } });
}

export function tutoring(input) {
  const rubric = array(input.rubric, 'rubric', 100);
  const answers = array(input.answers, 'answers', 10000);
  const evaluations = answers.map((answer) => {
    const criteria = rubric.map((criterion) => {
      const matched = (criterion.keywords || []).filter((keyword) => String(answer.text || '').toLowerCase().includes(keyword.toLowerCase()));
      const points = Math.round((criterion.points || 1) * matched.length / Math.max((criterion.keywords || []).length, 1));
      return { criterion: criterion.name, points, maxPoints: criterion.points || 1, feedback: matched.length ? 'Зафиксированы ожидаемые элементы ответа.' : 'Требуется дополнить ответ по критерию.' };
    });
    const score = criteria.reduce((sum, c) => sum + c.points, 0), maximum = criteria.reduce((sum, c) => sum + c.maxPoints, 0);
    return { learnerId: answer.learnerId, score, maximum, ratio: maximum ? score / maximum : 0, criteria, nextTrack: maximum && score / maximum < 0.7 ? 'foundations_and_additional_practice' : 'advanced_practice', humanReviewRequired: true };
  });
  return result({ evaluations, status: 'draft_feedback' }, { usage: { unit: 'assignment', quantity: Math.max(1, answers.length) } });
}

export function clinic(input) {
  const request = text(input.request, 'request', 100000);
  if (/сильн\w*\s+бол|кровотеч|не\s+могу\s+дышать|без\s+сознан|судорог|инсульт|инфаркт/i.test(request)) return result({ triage: 'emergency', reply: 'При угрожающих жизни симптомах немедленно обратитесь в экстренную службу. Запись к врачу не заменяет неотложную помощь.', diagnosis: null }, { usage: { unit: 'request', quantity: 1 } });
  const slots = array(input.slots, 'slots', 10000);
  const specialty = input.specialty || slots.find((slot) => request.toLowerCase().includes(String(slot.specialty || '').toLowerCase()))?.specialty;
  const slot = slots.find((candidate) => candidate.available && (!specialty || candidate.specialty === specialty) && (!input.preferredAt || candidate.startAt === input.preferredAt));
  const reply = slot ? `Нашёл свободное время: ${slot.startAt}. Подтвердите запись.` : 'Свободного времени по заданным параметрам нет; уточните другую дату или специалиста.';
  const effects = slot ? [{ type: 'clinic.book', integration: input.integration || 'mis', payload: { slotId: slot.id, patientReference: input.patientReference, request }, consequential: true }] : [];
  return result({ triage: 'administrative', reply, selectedSlot: slot || null, diagnosis: null, medicalAdviceProvided: false }, { effects, usage: { unit: 'request', quantity: 1 } });
}
