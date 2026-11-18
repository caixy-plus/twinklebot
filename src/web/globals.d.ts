import "react";

declare module "react" {
  interface DialogHTMLAttributes<T> {
    closedby?: "any" | "closerequest" | "none";
  }
  interface SVGAttributes<T> {
    hidden?: boolean;
  }
}

declare global {
  interface Window {
    __TWINKLEBOT_APP_TARGET__?: any;
    twinklebotDesktop?: any;
    Capacitor?: any;
    SpeechRecognition?: any;
    webkitSpeechRecognition?: any;
    [key: string]: any;
  }
}
