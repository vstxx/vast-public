import { Fragment } from 'react'
import { parseRelayRichText, type RelayRichTextInline } from '../../../shared/relay-rich-text'

function inlineContent(content: RelayRichTextInline[]): JSX.Element {
  return (
    <>
      {content.map((node, index) => {
        if (node.kind === 'strong') return <strong key={index}>{node.value}</strong>
        if (node.kind === 'emphasis') return <em key={index}>{node.value}</em>
        if (node.kind === 'code') return <code key={index}>{node.value}</code>
        return <Fragment key={index}>{node.value}</Fragment>
      })}
    </>
  )
}

export function RelayRichText({ body }: { body: string }): JSX.Element {
  return (
    <div className="relay-rich-text" data-testid="relay-rich-text">
      {parseRelayRichText(body).map((block, index) => {
        if (block.kind === 'heading') {
          if (block.level === 1) return <h3 key={index}>{inlineContent(block.content)}</h3>
          if (block.level === 2) return <h4 key={index}>{inlineContent(block.content)}</h4>
          return <h5 key={index}>{inlineContent(block.content)}</h5>
        }
        if (block.kind === 'paragraph') return <p key={index}>{inlineContent(block.content)}</p>
        if (block.kind === 'quote') return <blockquote key={index}>{inlineContent(block.content)}</blockquote>
        if (block.kind === 'code-block') return <pre key={index}><code>{block.value}</code></pre>
        if (block.kind === 'divider') return <hr key={index} />
        const List = block.kind === 'ordered-list' ? 'ol' : 'ul'
        return (
          <List key={index}>
            {block.items.map((item, itemIndex) => <li key={itemIndex}>{inlineContent(item)}</li>)}
          </List>
        )
      })}
    </div>
  )
}
