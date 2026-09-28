// Self-harm and suicide messages get helplines, never a sales reply. This runs
// before the AI is called and before the per-post opt-in: safety comes first.
// The AI service has the same check as a second line.

const PATTERNS = [
  // English
  String.raw`\b(?:kill|killing|hang|hanging|hurt|hurting|harm|harming|cut|cutting)\s+(?:my\s*self|myself)\b`,
  String.raw`\bsuicid\w*`,
  String.raw`\bend(?:ing)?\s+(?:my|this)\s+life\b`,
  String.raw`\btake\s+my\s+(?:own\s+)?life\b`,
  String.raw`\b(?:want|wanna|going|ready|plan(?:ning)?)\s+to\s+die\b`,
  String.raw`\bdon'?t\s+want\s+to\s+(?:live|be\s+alive|wake\s+up)\b`,
  String.raw`\bno\s+reason\s+to\s+live\b`,
  String.raw`\bbetter\s+off\s+dead\b`,
  String.raw`\bself[\s-]?harm\w*`,
  // Hinglish (Roman script)
  String.raw`\b(?:khud\s*ko|apne\s*aap\s*ko)\s+(?:maar|mar|khatam|nuksan|hurt)`,
  String.raw`\b(?:mar|marr)\s*(?:jaana|jana|jaunga|jaungi|jaaunga|jaaungi|jaun|jaau)\b`,
  String.raw`\bmarna\s+(?:hai|chahta|chahti|chahata)\b`,
  String.raw`\bjeena\s+nahi\s+(?:hai|chahta|chahti)\b`,
  String.raw`\bjeene\s+ka\s+(?:mann|man)\s+nahi\b`,
  String.raw`\bzindagi\s+(?:khatam|se\s+tang)\b`,
  String.raw`\b(?:atmhatya|aatmhatya|aatmahatya|atmahatya|khudkushi|khudkhushi)\b`,
  String.raw`\b(?:zeher|zehar|zahar|jeher)\s+(?:kha|pee|pi)\w*`,
  String.raw`\bfaansi\b|\bphansi\s+(?:laga|lagaa)`,
  // Devanagari (no \b: JavaScript word boundaries are ASCII-only)
  'आत्महत्या|ख़ुदकुशी|खुदकुशी|मरना\\s*(?:है|चाहता|चाहती)|जीना\\s*नहीं|ज़हर\\s*खा|जहर\\s*खा|फाँसी|फांसी|ख़ुद\\s*को\\s*मार|खुद\\s*को\\s*मार',
];
const CRISIS = new RegExp(PATTERNS.join('|'), 'i');

const HINGLISH =
  /\b(?:hai|hain|nahi|nahin|kya|mujhe|mera|meri|main|mai|hoon|hu|kar|karna|chahta|chahti|zindagi|jeena|marna|jaana|kuch|koi|aap|tum|yaar|bhai|kaise|kyun|ab|abhi|kab|kitna|kitne|milega|chahiye)\b/i;

export const CRISIS_PUBLIC = "We've sent you a message 🙏";

const HELPLINES = {
  english:
    "We're really sorry you're going through this. You don't have to face it alone. Please talk to someone right now:\n" +
    '• Tele-MANAS: 14416 (free, 24x7)\n• KIRAN: 1800-599-0019\n• Emergency: 112\n' +
    'If you are in immediate danger, please call 112.',
  hinglish:
    'Humein bahut afsos hai ki aap itna mushkil waqt dekh rahe hain. Aap akele nahi hain. Please abhi kisi se baat kariye:\n' +
    '• Tele-MANAS: 14416 (free, 24x7)\n• KIRAN: 1800-599-0019\n• Emergency: 112\n' +
    'Agar aap abhi khatre mein hain to turant 112 par call kariye.',
  hindi:
    'हमें बहुत अफ़सोस है कि आप इतने मुश्किल समय से गुज़र रहे हैं। आप अकेले नहीं हैं। कृपया अभी किसी से बात कीजिए:\n' +
    '• टेली-मानस: 14416 (मुफ़्त, 24x7)\n• किरण: 1800-599-0019\n• आपातकाल: 112\n' +
    'अगर आप अभी ख़तरे में हैं तो तुरंत 112 पर कॉल कीजिए।',
};

function normalize(text: string): string {
  return (text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[​-‍⁠﻿]/g, '');
}

export function isCrisis(text: string | null | undefined): boolean {
  return CRISIS.test(normalize(text || ''));
}

export type Language = 'english' | 'hinglish' | 'hindi';

export function languageOf(text: string | null | undefined): Language {
  const t = text || '';
  if (/[ऀ-ॿ]/.test(t)) return 'hindi';
  if (HINGLISH.test(t)) return 'hinglish';
  return 'english';
}

export function crisisReply(text: string): string {
  return HELPLINES[languageOf(text)];
}

/** "Aapka message mil gaya hai" when the AI service cannot be reached. */
export function receivedReply(text: string): string {
  return languageOf(text) === 'english'
    ? 'Got your message 🙏 Our team will get back to you shortly.'
    : 'Aapka message mil gaya hai 🙏 Team jaldi aapko reply karegi.';
}
