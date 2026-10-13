export function createTypedConfirmation({ typedPhrases, prompt, log, DriverStop }) {
  return async function typed(phrase, meaning = '') {
    if (typedPhrases.has(phrase)) {
      return phrase
    }
    const answer = (await prompt(`Type ${phrase} to continue${meaning}:\n`)).trim()
    if (answer !== phrase) {
      throw new DriverStop(`expected ${phrase}; nothing further was dispatched`)
    }
    typedPhrases.set(phrase, answer)
    log(`operator typed ${phrase}`)
    return answer
  }
}
