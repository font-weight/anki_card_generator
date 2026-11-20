import {GRAMMAR_CHAT_OUTPUT_TOKENS} from '../../../../packages/contracts/src/grammar-question';

export const grammarFeatureLabel = 'Разбор предложения по левому Alt';
export const languageFeatureLabel = 'Разбор предложения и языковой чат по левому Alt';
export const grammarRequestCost = 'Новый разбор отправляет одно предложение в OpenAI. Это платный запрос. Готовый разбор открывается без нового запроса.';
export const languageChatCost = `Запрос к OpenAI оплачивается по вашему API-тарифу. Ответ может содержать до ${GRAMMAR_CHAT_OUTPUT_TOKENS.toLocaleString('ru-RU')} выходных токенов.`;
export const languageChatContext = 'Для новой темы в OpenAI отправляются только ваш вопрос и языковые настройки. Короткое уточнение использует недавние реплики этой темы в открытой карточке. Чтобы начать с чистого листа, отправьте «Новая тема». При вопросе о фразе могут передаваться исходное предложение и его разбор.';
