import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Center } from "@astryxdesign/core/Center";
import { Icon } from "@astryxdesign/core/Icon";
import { Link } from "@astryxdesign/core/Link";
import { Selector } from "@astryxdesign/core/Selector";
import { Spinner } from "@astryxdesign/core/Spinner";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Step, Stepper } from "@astryxdesign/core/Stepper";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useToast } from "@astryxdesign/core/Toast";
import {
  ArrowPathIcon,
  CheckCircleIcon,
  QrCodeIcon,
} from "@heroicons/react/24/outline";
import { apiGet, apiPost } from "@/lib/api";
import type { AgentKind, OnboardState } from "@/lib/types";

type Phase = "loading" | "waiting" | "confirm" | "creating" | "error";

function uniqueName(base: string, existing: string[]): string {
  if (!existing.includes(base)) return base;
  let index = 2;
  while (existing.includes(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

export function OnboardWizard({ onCreated }: { onCreated: (profile: string) => void }) {
  const [agentKind, setAgentKind] = useState<AgentKind>("claude");
  const [profileName, setProfileName] = useState("");
  const [botName, setBotName] = useState("");
  const [detected, setDetected] = useState<AgentKind[]>([]);
  const [existing, setExisting] = useState<string[]>([]);
  const [qr, setQr] = useState<{ sessionId: string; qrUrl: string; expireIn: number } | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const scanned = useRef(false);
  const showToast = useToast();

  useEffect(() => {
    void apiGet<OnboardState>("/api/onboard/state")
      .then((state) => {
        setDetected(state.detectedAgents);
        setExisting(state.profiles);
        if (state.detectedAgents.length && !state.detectedAgents.includes("claude")) {
          setAgentKind(state.detectedAgents[0]!);
        }
      })
      .catch(() => undefined);
  }, []);

  const stopPolling = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  };

  async function poll(sessionId: string) {
    let state: { status: string; error?: string; botName?: string; suggestedProfile?: string };
    try {
      state = await apiGet(`/api/profiles/qr/status?sessionId=${encodeURIComponent(sessionId)}`);
    } catch {
      return;
    }
    if (state.status === "scanned" && !scanned.current) {
      scanned.current = true;
      stopPolling();
      setBotName(state.botName ?? "");
      setProfileName(state.suggestedProfile || uniqueName(agentKind, existing));
      setPhase("confirm");
    } else if (state.status === "error") {
      stopPolling();
      setPhase("error");
      showToast({ body: state.error ?? "扫码创建失败", type: "error" });
    }
  }

  async function generate() {
    stopPolling();
    scanned.current = false;
    setQr(null);
    setPhase("loading");
    try {
      const result = await apiPost<{ sessionId: string; qrUrl: string; expireIn: number }>(
        "/api/profiles/qr/start",
        {},
      );
      setQr(result);
      setPhase("waiting");
      timer.current = setInterval(() => void poll(result.sessionId), 2_000);
    } catch (e) {
      setPhase("error");
      showToast({ body: String((e as Error).message ?? e), type: "error" });
    }
  }

  async function confirmCreate() {
    if (!qr) return;
    setPhase("creating");
    try {
      const result = await apiPost<{ profile: string }>("/api/profiles/qr/finish", {
        sessionId: qr.sessionId,
        agentKind,
        profile: profileName.trim(),
      });
      showToast({ body: `Profile「${result.profile}」已创建` });
      onCreated(result.profile);
    } catch (e) {
      setPhase("confirm");
      showToast({ body: String((e as Error).message ?? e), type: "error" });
    }
  }

  useEffect(() => {
    void generate();
    return stopPolling;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeStep = phase === "confirm" || phase === "creating" ? 1 : 0;
  const duplicate = existing.includes(profileName.trim());

  return (
    <VStack gap={5}>
      <Stepper activeStep={activeStep} density="compact" indicatorPosition="on-track" label="创建 Profile 进度">
        <Step step={0} label="创建飞书应用" description="扫码授权" />
        <Step step={1} label="绑定本地 Agent" description="确认名称与引擎" />
      </Stepper>

      {activeStep === 1 ? (
        <VStack gap={4}>
          <Banner
            status="success"
            title="飞书应用已创建"
            description={botName ? `已识别应用：${botName}` : "继续确认本地 Profile 信息。"}
            icon={<Icon icon={CheckCircleIcon} size="md" />}
            collapsible={false}
          />
          <Selector
            label="AI Agent"
            description="选择该 Profile 使用的本地执行器。"
            value={agentKind}
            options={[
              { value: "claude", label: "Claude Code", disabled: detected.length > 0 && !detected.includes("claude") },
              { value: "codex", label: "Codex", disabled: detected.length > 0 && !detected.includes("codex") },
            ]}
            onChange={(value) => setAgentKind(value as AgentKind)}
            width="100%"
          />
          <TextInput
            label="Profile 名称"
            description="名称必须唯一，不会覆盖已有 Profile。"
            value={profileName}
            onChange={setProfileName}
            placeholder={agentKind}
            status={duplicate ? { type: "error", message: "已存在同名 Profile，请换一个名称。" } : undefined}
            width="100%"
          />
          <HStack hAlign="end">
            <Button
              label="完成创建"
              variant="primary"
              isLoading={phase === "creating"}
              isDisabled={phase === "creating" || !profileName.trim() || duplicate}
              onClick={() => void confirmCreate()}
            />
          </HStack>
        </VStack>
      ) : (
        <VStack gap={4} hAlign="center">
          <Card padding={4} variant="muted" width={248} height={248}>
            <Center width="100%" height="100%">
              {qr ? (
                <Card padding={3} style={{ background: "white" }}>
                  <QRCodeSVG value={qr.qrUrl} size={196} />
                </Card>
              ) : phase === "loading" ? (
                <Spinner size="lg" label="生成二维码中…" />
              ) : (
                <Icon icon={QrCodeIcon} size="lg" color="secondary" />
              )}
            </Center>
          </Card>
          <VStack gap={1} hAlign="center">
            <Text weight="semibold">用飞书 App 扫码创建新应用</Text>
            <Text type="supporting" color="secondary">
              {phase === "error" ? "二维码生成失败，请重试。" : "扫码完成后自动进入下一步。"}
            </Text>
            {qr && (
              <HStack gap={2} vAlign="center" wrap="wrap" hAlign="center">
                <Badge variant="neutral" label={`约 ${Math.max(1, Math.round(qr.expireIn / 60))} 分钟有效`} />
                <Link href={qr.qrUrl} isExternalLink type="supporting">在浏览器打开</Link>
              </HStack>
            )}
          </VStack>
          {(phase === "error" || phase === "waiting") && (
            <Button
              label="重新生成"
              variant="secondary"
              icon={<Icon icon={ArrowPathIcon} size="sm" />}
              onClick={() => void generate()}
            />
          )}
        </VStack>
      )}

      {detected.length === 0 && (
        <Banner
          status="warning"
          title="未检测到本地 Agent"
          description="请先安装 Claude Code 或 Codex，再完成 Profile 创建。"
          collapsible={false}
        />
      )}
      <Text type="supporting" color="secondary" justify="center" display="block">
        扫码人会成为应用 owner，并自动豁免访问控制。
      </Text>
    </VStack>
  );
}
