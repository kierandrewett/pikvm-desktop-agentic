/**
 * Thread avatars (`ui.thread.avatars`): the signed-in user's picture or monogram (ui/avatar.tsx), and the vendor logo
 * of the conversation's model (the same logo the model picker shows), with a neutral mark fallback.
 */
import type { ConversationSummary } from "@pikvm/chat-protocol";
import { ChatsCircleIcon } from "@pikvm/icons";
import { skipToken, useQuery } from "@tanstack/react-query";
import { memo, useContext } from "react";
import { conversationsQuery, keys, useBootstrap } from "../../lib/queries";
import { ThreadContext } from "./context";
import { modelsQuery } from "../model-picker/models";
import { ModelMark } from "../model-picker/provider-logo";
import { Avatar } from "../ui/avatar";

const SIZE = 28;

export const UserAvatar = memo(function UserAvatar() {
    const user = useBootstrap().data?.user;
    if (!user) return <span className="thread-avatar" />;
    return <Avatar name={user.name} email={user.email} image={user.image} size={SIZE} className="thread-avatar" />;
});

export const AssistantAvatar = memo(function AssistantAvatar({ conversationId }: { conversationId: string }) {
    const { preview } = useContext(ThreadContext);
    const { data: listed } = useQuery({
        ...conversationsQuery(),
        enabled: !preview && !!conversationId,
        select: (list) => list.find((c) => c.id === conversationId)?.model,
    });
    const { data: summary } = useQuery<ConversationSummary>({
        queryKey: keys.conversation(conversationId),
        queryFn: skipToken,
    });
    const { data: models } = useQuery({ ...modelsQuery, enabled: !preview });
    const model = models?.models.find((m) => m.id === (summary?.model ?? listed));
    return (
        <span aria-hidden className="thread-avatar border border-default bg-surface text-text">
            {model ? <ModelMark model={model} size={16} /> : <ChatsCircleIcon size={16} className="text-secondary" />}
        </span>
    );
});

export const AVATAR_SIZE = SIZE;
