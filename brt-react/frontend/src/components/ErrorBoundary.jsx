import React from 'react';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("ErrorBoundary caught an error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="card error" style={{ padding: '20px', margin: '20px 0', borderRadius: '8px', border: '1px solid #f87171', backgroundColor: '#fef2f2' }}>
          <h3 style={{ color: '#b91c1c', marginTop: 0 }}>Something went wrong while rendering the layout.</h3>
          <p style={{ color: '#7f1d1d' }}>{this.state.error && this.state.error.toString()}</p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{ marginTop: '10px', padding: '8px 16px', backgroundColor: '#ef4444', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
          >
            Try Again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
