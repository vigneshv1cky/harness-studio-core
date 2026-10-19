/** Ordered Chat rows, local echoes, and running status share the flow slot's parent. */
import { memo } from 'react'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { ChatFlowSlotProps } from '../contract/slots.ts'
import { ChatNodeSeat } from './ChatNodeSeat.tsx'
import { ChatGroupSeat } from './ChatGroupSeat.tsx'
import { PendingSteeringBubble, PendingSubmissionBubble } from './MessageItem.tsx'
import { chatRenderKey } from './render-entry.ts'
import { RunningStatus } from './RunningStatus.tsx'

/** Render the flow without adding a DOM parent or changing keyed row positions. */
export const ChatFlow = memo(function ChatFlow({
  entries, pendingInputs, lastInputTurn, deferCollapse, steeringItemIds, unsendSteering,
  useSession, useChat, useChatNode, useChatNodeBottom, useChatNodeProcess, useChatGroup, usePresentation,
  useStore, actions, renderSlot, renderFactorySlot, t, useGroupAction, useGroupHeaderAction,
  cwd, openFile, inspectCall, forkAt, loadImage, fileMentions,
}: ChatFlowSlotProps) {
  const nodeStore = useChat(snapshot => snapshot.nodes)
  const running = useSession(snapshot => snapshot.running)
  const latestTurnAnchor = useChat(snapshot => snapshot.navigation.items().at(-1)?.anchorKey)
  const runningStartTime = useChatNode(latestTurnAnchor ?? '', (node) => {
    const location = node?.location
    return location?.kind === 'turn' || location?.kind === 'step'
      ? location.turn.status === 'open' ? location.turn.start?.time : undefined
      : undefined
  })
  const seatProps = {
    nodeStore, useChatNode, useChatNodeBottom, useChatNodeProcess, usePresentation,
    useStore, actions, renderSlot, t, useGroupAction, deferCollapse,
    cwd, openFile, inspectCall, forkAt, loadImage, fileMentions,
  }
  const rows = entries.map((entry) => {
    switch (entry.kind) {
      case 'node':
        return <ChatNodeSeat {...seatProps} key={chatRenderKey(entry)} nodeKey={entry.key}
          {...entry.groupPart === undefined ? {} : { groupPart: entry.groupPart }} />
      case 'group':
        return <ChatGroupSeat {...seatProps} key={chatRenderKey(entry)} groupKey={entry.key}
          useChatGroup={useChatGroup} useGroupHeaderAction={useGroupHeaderAction} />
      default:
        return assertNever(entry)
    }
  })
  // Only text-only messages can be taken back: attachments have no place to return to in the composer.
  const unsendFor = (itemId: MessageId | undefined, text: string) => (
    itemId === undefined || unsendSteering === undefined ? undefined : () => unsendSteering(itemId, text)
  )
  const pendingRows = pendingInputs.map((item) => {
    if ('requestId' in item) {
      const itemId = item.placement === 'steering' && item.attachments.length === 0
        ? steeringItemIds?.get(item.requestId) : undefined
      return (
        <PendingSubmissionBubble key={item.requestId} submission={item} onUnsend={unsendFor(itemId, item.text)}
          loadImage={loadImage} renderFactorySlot={renderFactorySlot} t={t} />
      )
    }
    const texts = item.content.flatMap(part => part.type === 'text' ? [part.text] : [])
    return (
      <PendingSteeringBubble key={item.id} content={item.content}
        onUnsend={texts.length === item.content.length ? unsendFor(item.id, texts.join('\n')) : undefined}
        loadImage={loadImage} renderFactorySlot={renderFactorySlot} t={t} />
    )
  })
  const tail = entries.at(-1)
  const node = tail?.kind === 'node' ? nodeStore.get(tail.key) : undefined
  // An empty opening control follows one local transcript echo, never steering.
  // All rows share this keyed list so inserting the control keeps the echo mounted.
  if (node?.kind === 'turn-process' && node.location.kind === 'turn'
    && node.location.turn.status === 'open' && node.location.turn.turn !== lastInputTurn) {
    const index = pendingInputs.findIndex(item => 'requestId' in item && item.placement === 'transcript')
    if (index !== -1) rows.splice(rows.length - 1, 0, ...pendingRows.splice(index, 1))
  }
  return [...rows, ...pendingRows, ...running ? [<RunningStatus key="running" startTime={runningStartTime} t={t} />] : []]
})
