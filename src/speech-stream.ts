import { lazyStream, type AssistantMessage, type AssistantMessageEvent, type Context, type Model, type Api, type SimpleStreamOptions } from '@earendil-works/pi-ai';
import { streamSimple as openAIStream } from '@earendil-works/pi-ai/api/openai-completions';

const markers = ['<think>', '</think>', '[thinking]', '[/thinking]'];
/** Remove explicitly marked internal notes, including unterminated blocks and split streaming delimiters. */
export function speechText(text: string, final = true) {
  let visible = ''; let hidden = false; let i = 0;
  while(i < text.length) {
    const rest = text.slice(i).toLowerCase();
    const marker = markers.find(m => rest.startsWith(m));
    if(marker) { hidden = marker === '<think>' || marker === '[thinking]'; i += marker.length; continue; }
    if(!final && markers.some(m => m.startsWith(rest))) break;
    if(!hidden) visible += text[i]; i++;
  }
  return visible;
}
/** Only suppress an exact leading repeat of an already displayed opening. Never rewrite a differing judgment. */
export function continuationText(text: string, opening: string, final = true) {
  if(!opening) return text;
  const candidate = text.trimStart();
  if(opening.startsWith(candidate)) return !final || opening === candidate ? '' : text;
  if(candidate.startsWith(opening)) return candidate.slice(opening.length).trimStart();
  return text;
}
function shownOpening(context: Context) {
  const last = context.messages.at(-1);
  if(last?.role !== 'toolResult' || last.toolName !== 'reflect' || last.isError) return '';
  try {
    const data = JSON.parse(last.content.filter(c=>c.type==='text').map(c=>c.text).join(''));
    return data.status === 'considered' && typeof data.openingAlreadyShown === 'string' ? data.openingAlreadyShown.trim() : '';
  } catch { return ''; }
}
function clean(message: AssistantMessage, final = false, opening = ''): AssistantMessage {
  const firstText = message.content.findIndex(c=>c.type==='text');
  return { ...message, content: message.content.map((c,i) => c.type === 'text' ? {...c,text:continuationText(speechText(c.text,final),i===firstText?opening:'',final)} : c.type === 'thinking' ? {...c,thinking:''} : c) };
}
export function conversationalStream(model: Model<Api>, context: Context, options?: SimpleStreamOptions) {
  const source = openAIStream(model as Model<'openai-completions'>, context, options);
  if(options?.reasoning) return source; // The private reflection request keeps its native reasoning channel.
  const opening = shownOpening(context);
  return lazyStream(model, async () => (async function*(): AsyncGenerator<AssistantMessageEvent> {
    const emitted = new Map<number,string>();
    for await(const event of source) {
      if(event.type.startsWith('thinking_')) continue;
      if(event.type === 'done') {yield {...event,message:clean(event.message,true,opening)}; continue;}
      if(event.type === 'error') {yield {...event,error:clean(event.error,true,opening)}; continue;}
      if(event.type === 'text_delta' || event.type === 'text_end') {
        const block = event.partial.content[event.contentIndex];
        const visible = continuationText(speechText(block.type === 'text' ? block.text : '', event.type === 'text_end'), event.contentIndex===event.partial.content.findIndex(c=>c.type==='text')?opening:'',event.type==='text_end');
        const previous = emitted.get(event.contentIndex) ?? '';
        const delta = visible.slice(previous.length); emitted.set(event.contentIndex, visible);
        if(delta) yield {type:'text_delta',contentIndex:event.contentIndex,delta,partial:clean(event.partial,event.type==='text_end',opening)};
        if(event.type === 'text_end') yield {...event,content:visible,partial:clean(event.partial,true,opening)};
        continue;
      }
      if('partial' in event) yield {...event,partial:clean(event.partial,false,opening)};
    }
  })());
}
