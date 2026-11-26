use clap::{Parser, Subcommand};
use std::{net::SocketAddr, path::PathBuf, sync::Arc};
use tracing_subscriber::EnvFilter;

mod app;
mod cover;
mod db;
mod http;
mod roots;
mod scanner;

#[derive(Parser)]
#[command(name = "henshin-server", about = "Read-only comic library server")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Serve {
        #[arg(long)]
        data_dir: PathBuf,
        #[arg(long, default_value = "0.0.0.0:4317")]
        listen: SocketAddr,
        #[arg(long)]
        token: Option<String>,
    },
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();
    match Cli::parse().command {
        Command::Serve {
            data_dir,
            listen,
            token,
        } => {
            let state = Arc::new(app::AppState::open(data_dir, token)?);
            let listener = tokio::net::TcpListener::bind(listen).await?;
            tracing::info!(address = %listener.local_addr()?, "server listening");
            axum::serve(listener, http::router(state))
                .with_graceful_shutdown(shutdown_signal())
                .await?;
        }
    }
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        let _ = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install signal handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = terminate => {} }
}
