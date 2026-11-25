import React from "react";
import { AlertTriangle, RotateCw } from "lucide-react";

interface PageErrorBoundaryProps {
  pageKey: string;
  children: React.ReactNode;
}

interface PageErrorBoundaryState {
  hasError: boolean;
  retryNonce: number;
}

export class PageErrorBoundary extends React.Component<
  PageErrorBoundaryProps,
  PageErrorBoundaryState
> {
  constructor(props: PageErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, retryNonce: 0 };
  }

  static getDerivedStateFromError(): Partial<PageErrorBoundaryState> {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.error("[page-error-boundary]", error);
  }

  componentDidUpdate(prevProps: PageErrorBoundaryProps) {
    if (prevProps.pageKey !== this.props.pageKey && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  private handleReload = () => {
    this.setState((prev) => ({
      hasError: false,
      retryNonce: prev.retryNonce + 1,
    }));
  };

  render() {
    if (this.state.hasError) {
      return (
        <section
          role="alert"
          data-testid="page-error-boundary"
          className="bg-white border border-rose-200 rounded-lg p-6 max-w-xl space-y-3"
        >
          <div className="flex items-center gap-2 text-rose-800">
            <AlertTriangle className="h-5 w-5 shrink-0" />
            <h2 className="text-base font-bold">此頁發生錯誤</h2>
          </div>
          <p className="text-sm text-slate-600 leading-relaxed">
            此頁面在渲染或處理資料時發生未預期問題，其他頁面與導覽功能仍可正常使用。
          </p>
          <div>
            <button
              type="button"
              onClick={this.handleReload}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-[#0B63CE] text-white text-sm font-medium hover:bg-[#0952AD]"
            >
              <RotateCw className="h-4 w-4" />
              重新載入
            </button>
          </div>
        </section>
      );
    }

    return <React.Fragment key={this.state.retryNonce}>{this.props.children}</React.Fragment>;
  }
}
