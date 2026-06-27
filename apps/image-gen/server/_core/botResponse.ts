export type ConversationAction = {
  id: string;
  label: string;
  inputText?: string;
};

type ImageOutput = {
  imageUrl: string;
  caption?: string;
};

export type ConversationResponse = {
  text?: string;
  images?: ImageOutput[];
  actions?: ConversationAction[];
};

export type BotResponse =
  | ConversationResponse
  | {
      kind: "text";
      text: string;
      actions?: ConversationAction[];
    }
  | {
      kind: "image";
      imageUrl: string;
      caption?: string;
    }
  | {
      kind: "error";
      text: string;
    }
  | {
      kind: "ack";
    }
  | {
      kind: "typing";
    };
