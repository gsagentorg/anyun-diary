<script lang="ts">
  import { SLEEP_CUSTOM_FIELDS, sleepCurvePath, sleepCustomWindow, type SleepCustomParameters } from '../sleep-curves';
  let { parameters, onchange, onreset, running = false, supported = true }: {
    parameters: SleepCustomParameters;
    onchange: (value: SleepCustomParameters) => void;
    onreset: () => void;
    running?: boolean;
    supported?: boolean;
  } = $props();
  const window = $derived(sleepCustomWindow(parameters));
  function edit(key: keyof SleepCustomParameters, element: HTMLInputElement) {
    const value = element.valueAsNumber;
    if (element.value === '' || !Number.isFinite(value) || !element.validity.valid) return;
    onchange({ ...parameters, [key]: value });
  }
</script>

<fieldset class="my-2 rounded-md border border-base-300 p-2" data-sleep-editor>
  <legend class="px-1 text-xs">{running ? '下次启动参数（不改变当前运行）' : '自定义曲线参数'}</legend>
  {#each SLEEP_CUSTOM_FIELDS as field (field.key)}
    <div class="mb-2 text-2xs">
      <label class="block">
        {field.label}
        <input type="range" min={field.min} max={field.max} step={field.step}
          value={parameters[field.key]} aria-label={field.label + '滑块'}
          oninput={(event) => edit(field.key, event.currentTarget)} class="block w-full accent-accent" />
      </label>
      <label class="flex items-center justify-between gap-2">
        <span>{field.label}数值</span>
        <input type="number" min={field.min} max={field.max} step={field.step}
          value={parameters[field.key]} aria-label={field.label + '数值'}
          oninput={(event) => edit(field.key, event.currentTarget)}
          onblur={(event) => { event.currentTarget.value = String(parameters[field.key]); }}
          class="w-20 rounded border border-base-300 bg-base-100 px-1 py-1 tabular-nums" />
      </label>
    </div>
  {/each}
  <svg viewBox="-4 0 188 44" role="img" aria-label="下次启动自定义曲线实时预览，横轴时间，纵轴相对分贝" class="h-14 w-full text-accent" data-sleep-custom-preview>
    <path d="M0,38 H180" fill="none" stroke="currentColor" opacity="0.2" />
    <path d={sleepCurvePath('custom', parameters)} fill="none" stroke="currentColor" stroke-width="2" />
  </svg>
  <p class="text-2xs opacity-70">尾段为 0 时到时切断；尾段与保持段重叠时，最多使用剩余时间的一半归零，保留另一半渐弱。</p>
  <p class="text-2xs opacity-70" aria-live="polite">实际保持 {parameters.holdPercent}%，渐弱 {(window.fade * 100).toFixed(1)}%，归零 {(window.tail * 100).toFixed(1)}%。{running ? '修改仅用于重新开始。' : ''}</p>
  {#if !supported}<p class="mt-1 text-2xs text-warning" role="status">当前原生 App 尚未确认支持自定义曲线，请更新 App。可继续使用已有预设。</p>{/if}
  <button type="button" class="mt-2 rounded border border-base-300 px-2 py-1 text-xs" onclick={onreset}>恢复默认参数</button>
</fieldset>
