/**
 * 
 * @param {string} tag 
 * @param {string} content 
 * @param {object} properties 
 * @param {'normal' | 'self' | 'none'} closeType 
 */
export function general(tag, content, properties, closeType='normal') {
    return `<${tag}${Object.entries(properties).map(v => ` ${v[0]}="${v[1]}"`).join('')}${closeType == 'normal' ? `>${content}</${tag}` : closeType == 'self' ? '/' : ''}>`;
}

export const a = (content, properties) => general('a', content, properties, 'normal');