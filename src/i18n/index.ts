import cs from './cs'
import uk from './uk'

export type AppLanguage = 'cs' | 'uk'
export type TranslationKey = keyof typeof cs
export type TranslateFn = (key: TranslationKey, params?: Record<string, string | number>) => string

export const LANGUAGE_STORAGE_KEY = 'hotelOpsLanguage'

export const translations: Record<AppLanguage, Partial<Record<TranslationKey, string>>> = {
    cs,
    uk
}

export function resolveLanguage(value?: string | null): AppLanguage {
    return value === 'uk' ? 'uk' : 'cs'
}

export function getLanguageLocale(language: AppLanguage) {
    return language === 'uk' ? 'uk-UA' : 'cs-CZ'
}

function interpolate(template: string, params?: Record<string, string | number>) {
    if (!params) return template
    return Object.entries(params).reduce(
        (result, [key, value]) => result.replaceAll(`{${key}}`, String(value)),
        template
    )
}

export function translate(language: AppLanguage, key: TranslationKey, params?: Record<string, string | number>) {
    const value = translations[language][key] ?? translations.cs[key] ?? key
    return interpolate(String(value), params)
}

export function createTranslator(language: AppLanguage): TranslateFn {
    return (key, params) => translate(language, key, params)
}