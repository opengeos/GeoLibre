// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use tauri::{command, ipc::Channel, AppHandle, Runtime};

use crate::{GeolocationExt, PermissionStatus, PermissionType, Position, PositionOptions, Result};

#[command]
pub(crate) async fn get_current_position<R: Runtime>(
    app: AppHandle<R>,
    options: Option<PositionOptions>,
) -> Result<Position> {
    app.geolocation().get_current_position(options)
}

#[command]
pub(crate) async fn watch_position<R: Runtime>(
    app: AppHandle<R>,
    options: PositionOptions,
    channel: Channel,
) -> Result<()> {
    app.geolocation().watch_position_inner(options, channel)
}

#[command]
pub(crate) async fn clear_watch<R: Runtime>(app: AppHandle<R>, channel_id: u32) -> Result<()> {
    app.geolocation().clear_watch(channel_id)
}

#[command]
pub(crate) async fn check_permissions<R: Runtime>(app: AppHandle<R>) -> Result<PermissionStatus> {
    app.geolocation().check_permissions()
}

#[command]
pub(crate) async fn request_permissions<R: Runtime>(
    app: AppHandle<R>,
    permissions: Option<Vec<PermissionType>>,
) -> Result<PermissionStatus> {
    app.geolocation().request_permissions(permissions)
}
